defmodule Timemachine.History do
  @moduledoc """
  Schreibpfad: Dimensionstabelle, Gültigkeitsintervalle und Wochenaktivität.

  Der Zustand zu einem beliebigen Zeitpunkt ist damit eine indizierte Abfrage
  statt einer Rekonstruktion im Anwendungscode (Plan §2.2).
  """

  import Ecto.Query

  alias Timemachine.Repo
  alias Timemachine.Schema.{RepoActivity, Repository, RepoState}

  @doc """
  Legt das Repository an oder aktualisiert seine veränderlichen Attribute.

  Wer gerade in der Liste stand, ist sichtbar - `disappeared_at` wird dabei
  zurückgesetzt, damit ein wieder öffentlich gestelltes Repository ohne
  Sonderbehandlung zurückkehrt.
  """
  def upsert_repository(attrs) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    Repo.insert_all(
      Repository,
      [
        Map.merge(attrs, %{inserted_at: now, updated_at: now, disappeared_at: nil})
      ],
      on_conflict:
        {:replace, [:account, :name, :full_name, :fork, :private, :updated_at, :disappeared_at]},
      conflict_target: :repo_id
    )

    :ok
  end

  @doc "Die repo_ids, die für diesen Account als sichtbar gelten."
  def visible_repository_ids(account) do
    from(r in Repository,
      where: r.account == ^account and is_nil(r.disappeared_at),
      select: r.repo_id
    )
    |> Repo.all()
  end

  @doc """
  Markiert Repositories als verschwunden und schließt ihr offenes
  Zustandsintervall.

  `/users/:account/repos` liefert nur öffentliche Repositories. Fehlt eines in
  einer *erfolgreichen* Antwort, wurde es auf privat gestellt, gelöscht oder
  transferiert - in allen drei Fällen darf es nicht weiter veröffentlicht
  werden. Die Daten bleiben in der Datenbank, damit eine Rückkehr nichts
  kostet; nur der Materialisierer lässt sie aus.

  Die Lücke in `repo_state` ist dabei kein Mangel: `state_at/1` liefert für
  diesen Zeitraum korrekt nichts, weil der Zustand tatsächlich unbekannt war.
  """
  def mark_disappeared(repo_ids, at \\ nil)

  def mark_disappeared([], _at), do: {:ok, 0}

  def mark_disappeared(repo_ids, at) do
    at = (at || DateTime.utc_now()) |> DateTime.truncate(:second)

    Repo.transaction(fn ->
      {count, _} =
        from(r in Repository,
          where: r.repo_id in ^repo_ids and is_nil(r.disappeared_at)
        )
        |> Repo.update_all(set: [disappeared_at: at, updated_at: at])

      from(s in RepoState,
        where: s.repo_id in ^repo_ids and is_nil(s.valid_to)
      )
      |> Repo.update_all(set: [valid_to: at])

      count
    end)
  end

  @fingerprinted [:pushed_at, :stars, :forks, :size_kb, :language, :archived]

  @doc """
  Schreibt einen neuen Zustand, aber nur wenn er sich unterscheidet.

  Vergleich läuft über einen Hash der gespeicherten Felder, nicht über GitHubs
  `updated_at`: das reagiert auch auf Ereignisse, die für die Relevanz
  belanglos sind (Plan §2.5).

  Gibt `:unchanged` oder `:changed` zurück.
  """
  def record_state(repo_id, attrs, at \\ nil) do
    at = (at || DateTime.utc_now()) |> DateTime.truncate(:second)
    fingerprint = fingerprint(attrs)
    current = open_state(repo_id)

    cond do
      current && current.fingerprint == fingerprint ->
        :unchanged

      true ->
        Repo.transaction(fn ->
          if current do
            from(s in RepoState,
              where: s.repo_id == ^repo_id and is_nil(s.valid_to)
            )
            |> Repo.update_all(set: [valid_to: at])
          end

          Repo.insert_all(
            RepoState,
            [
              attrs
              |> Map.take(@fingerprinted)
              |> Map.merge(%{
                repo_id: repo_id,
                valid_from: at,
                valid_to: nil,
                fingerprint: fingerprint
              })
            ],
            # Zu einem Zeitpunkt kann genau ein Zustand gegolten haben. Fallen
            # zwei Beobachtungen auf dieselbe Sekunde - etwa wenn ein
            # Repository verschwindet und sofort zurückkehrt - gewinnt die
            # spätere, statt am Unique-Index zu scheitern.
            on_conflict: {:replace, [:valid_to, :fingerprint | @fingerprinted]},
            conflict_target: [:repo_id, :valid_from]
          )
        end)

        :changed
    end
  end

  defp fingerprint(attrs) do
    @fingerprinted
    |> Enum.map(&Map.get(attrs, &1))
    |> :erlang.phash2()
  end

  defp open_state(repo_id) do
    from(s in RepoState,
      where: s.repo_id == ^repo_id and is_nil(s.valid_to)
    )
    |> Repo.one()
  end

  @doc """
  Zustand aller Repositories zu einem Zeitpunkt - ein indizierter Zugriff,
  kein Delta-Replay.
  """
  def state_at(%DateTime{} = t) do
    from(s in RepoState,
      where: s.valid_from <= ^t and (is_nil(s.valid_to) or s.valid_to > ^t)
    )
    |> Repo.all()
  end

  @doc """
  Ersetzt die Wochen ab `from_week` durch die übergebenen Zählungen.

  Ersetzen statt Hochzählen: ein erneuter Lauf über einen überlappenden
  Zeitraum darf nicht doppelt zählen. Damit ist der Schreibvorgang idempotent.

  `counts` ist eine Map `%{~D[2026-07-19] => {commits, commits_own}}`.
  """
  def replace_weeks(repo_id, from_week, counts) do
    rows =
      counts
      |> Enum.map(fn {week, {commits, own}} ->
        %{repo_id: repo_id, week_start: week, commits: commits, commits_own: own}
      end)
      |> Enum.sort_by(& &1.week_start, Date)

    Repo.transaction(fn ->
      if from_week do
        from(a in RepoActivity,
          where: a.repo_id == ^repo_id and a.week_start >= ^from_week
        )
        |> Repo.delete_all()
      else
        from(a in RepoActivity, where: a.repo_id == ^repo_id) |> Repo.delete_all()
      end

      if rows != [], do: Repo.insert_all(RepoActivity, rows)
    end)

    :ok
  end

  @doc "Jüngste erfasste Woche eines Repositories, oder nil."
  def latest_week(repo_id) do
    from(a in RepoActivity,
      where: a.repo_id == ^repo_id,
      select: max(a.week_start)
    )
    |> Repo.one()
  end

  def repositories, do: Repo.all(Repository)

  @doc "Nur Repositories, die zuletzt öffentlich sichtbar waren."
  def visible_repositories do
    from(r in Repository, where: is_nil(r.disappeared_at)) |> Repo.all()
  end

  def activity do
    from(a in RepoActivity, order_by: [a.repo_id, a.week_start]) |> Repo.all()
  end
end
