defmodule Timemachine.Poller do
  @moduledoc """
  Periodischer Abgleich mit GitHub.

  Als GenServer, nicht als Timer-Schleife: die Mailbox ist seriell, damit
  können sich zwei Läufe konstruktiv nicht überholen, wenn GitHub einmal
  langsam antwortet. Der nächste Lauf wird erst nach dem Ende des vorherigen
  geplant.
  """

  use GenServer
  require Logger

  alias Timemachine.{GitHub, History, Timeline}

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "Löst einen Lauf aus und wartet auf das Ergebnis (für Tests und iex)."
  def poll_now(timeout \\ 120_000), do: GenServer.call(__MODULE__, :poll, timeout)

  @impl true
  def init(opts) do
    state = %{
      accounts: Keyword.get(opts, :accounts, Application.get_env(:timemachine, :accounts, [])),
      interval: Keyword.get(opts, :interval, Application.get_env(:timemachine, :poll_interval_ms))
    }

    # Erster Lauf sofort, aber asynchron - init darf nicht blockieren.
    # Abschaltbar, damit ein gezielter Einzellauf über poll_now/1 nicht hinter
    # einem bereits angestoßenen Durchgang wartet und die Requests verdoppelt.
    if Keyword.get(opts, :poll_on_start, true), do: send(self(), :poll)
    {:ok, state}
  end

  @impl true
  def handle_info(:poll, state) do
    run(state)
    Process.send_after(self(), :poll, state.interval)
    {:noreply, state}
  end

  @impl true
  def handle_call(:poll, _from, state) do
    {:reply, run(state), state}
  end

  defp run(state) do
    # Erst alle Accounts abgleichen, dann aufräumen: ein zwischen zwei
    # konfigurierten Accounts transferiertes Repository hat danach bereits
    # seinen neuen Account und gilt nicht fälschlich als verschwunden.
    results = Enum.map(state.accounts, &{&1, sync_account(&1, state.accounts)})
    gone = reconcile(results)

    {:ok, _path, bytes} = Timeline.write()
    Logger.info("poll finished, #{length(gone)} gone, timeline #{bytes} bytes")
    results
  end

  defp sync_account(account, own_logins) do
    case GitHub.list_repos(account) do
      :not_modified ->
        # 304 heißt: die Liste ist unverändert. Dann ist auch nichts
        # verschwunden - hier darf nicht aufgeräumt werden.
        Logger.info("#{account}: not modified")
        :not_modified

      {:ok, repos} ->
        Enum.each(repos, &sync_repo(&1, own_logins))
        {:ok, Enum.map(repos, & &1.repo_id)}

      {:error, error} ->
        # Ein fehlgeschlagener Account darf die anderen nicht mitreißen; der
        # nächste Lauf versucht es erneut.
        Logger.error("#{account}: #{Exception.message(error)}")
        {:error, error}
    end
  end

  @doc false
  # Schließt Repositories, die in einer erfolgreichen Liste fehlten. Bewusst
  # nur dort: bei :not_modified und bei Fehlern ist Abwesenheit keine
  # Information, und ein GitHub-Ausfall würde sonst die Timeline leeren.
  def reconcile(results, at \\ nil) do
    seen =
      for({_account, {:ok, ids}} <- results, do: ids)
      |> List.flatten()
      |> MapSet.new()

    missing =
      for {account, {:ok, _}} <- results, reduce: [] do
        acc -> acc ++ History.visible_repository_ids(account)
      end
      |> Enum.uniq()
      |> Enum.reject(&MapSet.member?(seen, &1))

    if missing != [] do
      Logger.warning("no longer public, removing from timeline: #{inspect(missing)}")
      History.mark_disappeared(missing, at)
    end

    missing
  end

  defp sync_repo(repo, own_logins) do
    History.upsert_repository(Map.drop(repo, [:state]))
    History.record_state(repo.repo_id, repo.state)

    # Nur die Wochen ab der jüngsten bekannten neu holen und ersetzen. Ersetzen
    # statt Hochzählen, damit ein überlappender Lauf nicht doppelt zählt.
    from_week = History.latest_week(repo.repo_id)
    since = from_week && week_to_datetime(from_week)

    case GitHub.weekly_commits(repo.full_name, own_logins, since) do
      {:ok, counts} when map_size(counts) > 0 ->
        write_weeks(repo, own_logins, from_week, counts)

      {:ok, _empty} ->
        :ok

      {:error, error} ->
        Logger.warning("#{repo.full_name}: #{Exception.message(error)}")
        :error
    end
  rescue
    error ->
      # Ein einzelnes Repository darf den Lauf nicht abbrechen - sonst nimmt es
      # die übrigen und den Materialisierer mit.
      Logger.error("#{repo.full_name}: #{Exception.message(error)}")
      :error
  end

  # GitHubs `since` filtert nach **Committer**-Datum, die Woche wird aber aus
  # dem **Author**-Datum gebildet (das sagt aus, wann gearbeitet wurde, nicht
  # wann es gelandet ist). Nach einem Rebase fallen beide auseinander: das
  # inkrementelle Fenster liefert dann Commits, deren Author-Datum vor
  # `from_week` liegt.
  #
  # Für solche Wochen hat das Fenster nur einen Ausschnitt gesehen - sie zu
  # ersetzen würde die Zahlen kleinrechnen. Also gilt eine ältere Woche als
  # Hinweis auf umgeschriebene Historie, und das Repository wird komplett neu
  # geholt. Kostet einen zusätzlichen Durchlauf, aber nur wenn es passiert.
  defp write_weeks(repo, own_logins, from_week, counts) do
    oldest = counts |> Map.keys() |> Enum.min(Date, fn -> nil end)

    if from_week && oldest && Date.compare(oldest, from_week) == :lt do
      Logger.info("#{repo.full_name}: rewritten history before #{from_week}, refetching in full")

      case GitHub.weekly_commits(repo.full_name, own_logins, nil) do
        {:ok, full} when map_size(full) > 0 ->
          History.replace_weeks(repo.repo_id, nil, full)

        {:ok, _empty} ->
          :ok

        {:error, error} ->
          # Nichts schreiben: lieber der alte Stand als ein halber.
          Logger.warning("#{repo.full_name}: full refetch failed, keeping previous data")
          Logger.warning("#{repo.full_name}: #{Exception.message(error)}")
          :error
      end
    else
      History.replace_weeks(repo.repo_id, from_week, counts)
    end
  end

  defp week_to_datetime(%Date{} = date) do
    DateTime.new!(date, ~T[00:00:00], "Etc/UTC")
  end
end
