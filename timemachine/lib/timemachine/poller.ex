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
    outcomes = Enum.map(state.accounts, &{&1, sync_account(&1, state.accounts)})

    results = Enum.map(outcomes, fn {account, {result, _synced}} -> {account, result} end)
    synced = outcomes |> Enum.map(fn {_account, {_result, n}} -> n end) |> Enum.sum()
    gone = reconcile(results)

    # Im Regelfall - alle fünf Minuten, ohne dass jemand etwas gepusht hat -
    # bleibt die Datei unangetastet. Sie neu zu schreiben ergäbe denselben
    # Inhalt bis auf generatedAt.
    case Timeline.write_unless_current(synced > 0 or gone != []) do
      {:ok, _path, bytes} ->
        Logger.info("poll finished, #{synced} updated, #{length(gone)} gone, #{bytes} bytes")

      :current ->
        Logger.debug("poll finished, nothing changed")
    end

    results
  end

  # Gibt `{ergebnis, anzahl_aktualisierter_repos}` zurück. Das Ergebnis behält
  # die Form, die reconcile/2 erwartet - die Zählung hängt nur daran, ob sich
  # die Timeline neu schreiben muss.
  defp sync_account(account, own_logins) do
    case GitHub.list_repos(account) do
      :not_modified ->
        # 304 heißt: die Liste ist unverändert. Dann ist auch nichts
        # verschwunden - hier darf nicht aufgeräumt werden.
        # Debug, nicht Info: im Fünf-Minuten-Takt ist das der Normalfall.
        Logger.debug("#{account}: not modified")
        {:not_modified, 0}

      {:ok, repos} ->
        synced =
          repos
          |> Enum.map(&sync_repo(&1, own_logins))
          |> Enum.count(&(&1 == :synced))

        {{:ok, Enum.map(repos, & &1.repo_id)}, synced}

      {:error, error} ->
        # Ein fehlgeschlagener Account darf die anderen nicht mitreißen; der
        # nächste Lauf versucht es erneut.
        Logger.error("#{account}: #{Exception.message(error)}")
        {{:error, error}, 0}
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

  # Die Liste eines Accounts wird schon dann neu geliefert, wenn sich an einem
  # einzigen Repository etwas geändert hat. Ohne die pushed_at-Prüfung würde
  # danach für *jedes* Repository die Commit-Liste geholt - im
  # Fünf-Minuten-Takt der Großteil des Kontingents für Antworten, die sich
  # nicht unterscheiden.
  #
  # Der teure Vollabgleich - ein Repository ohne `synced_pushed_at`, also ohne
  # je gelaufenen Backfill - passiert damit genau einmal.
  defp sync_repo(repo, own_logins) do
    History.upsert_repository(Map.drop(repo, [:state]))
    History.record_state(repo.repo_id, repo.state)
    pushed_at = repo.state.pushed_at

    if History.commits_synced?(repo.repo_id, pushed_at) do
      :unchanged
    else
      case sync_commits(repo, own_logins) do
        :ok ->
          # Erst nach dem Schreiben: ein abgebrochener Abgleich muss beim
          # nächsten Lauf erneut versuchen, statt als erledigt zu gelten.
          History.mark_commits_synced(repo.repo_id, pushed_at)
          :synced

        :error ->
          :error
      end
    end
  rescue
    error ->
      # Ein einzelnes Repository darf den Lauf nicht abbrechen - sonst nimmt es
      # die übrigen und den Materialisierer mit.
      Logger.error("#{repo.full_name}: #{Exception.message(error)}")
      :error
  end

  defp sync_commits(repo, own_logins) do
    # Nur die Wochen ab der jüngsten bekannten neu holen und ersetzen. Ersetzen
    # statt Hochzählen, damit ein überlappender Lauf nicht doppelt zählt.
    from_week = History.latest_week(repo.repo_id)
    since = from_week && week_to_datetime(from_week)

    case GitHub.weekly_commits(repo.full_name, own_logins, since) do
      {:ok, counts} when map_size(counts) > 0 ->
        write_weeks(repo, own_logins, from_week, counts)

      # Auch das ist ein erfolgreicher Abgleich: ein leeres Repository oder ein
      # Push auf einen Nebenzweig. Sonst bliebe es für immer ungeprüft.
      {:ok, _empty} ->
        :ok

      {:error, error} ->
        Logger.warning("#{repo.full_name}: #{Exception.message(error)}")
        :error
    end
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
