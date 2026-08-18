defmodule Timemachine.Timeline do
  @moduledoc """
  Materialisierer. Schreibt die komplette Historie als eine statische Datei,
  die nginx direkt ausliefert - die Anwendung liegt damit nicht im Request-Pfad
  des Sliders (Plan §6.3).

  Die Historie ist unveränderlich: der 15. März 2026 ändert sich nie wieder.
  Das ist deshalb kein Caching-Problem mit Invalidierung, sondern ein
  Build-Problem.
  """

  require Logger

  alias Timemachine.History

  @doc """
  Baut die Timeline und schreibt sie atomar nach `path`.

  Erst Temp-Datei, dann `rename` - sonst wird irgendwann eine halb geschriebene
  Datei ausgeliefert.
  """
  def write(path \\ nil) do
    path = path || Application.fetch_env!(:timemachine, :timeline_path)
    payload = build()
    json = Jason.encode!(payload)

    File.mkdir_p!(Path.dirname(path))
    tmp = path <> ".tmp"
    File.write!(tmp, json)
    File.rename!(tmp, path)

    Logger.info("timeline written: #{byte_size(json)} bytes -> #{path}")
    {:ok, path, byte_size(json)}
  end

  @doc """
  Schreibt nur, wenn es einen Grund gibt: geänderte Daten oder eine fehlende
  Datei. Gibt sonst `:current` zurück.

  Ein Poll-Lauf im Fünf-Minuten-Takt findet meistens nichts Neues. Die Datei
  dann trotzdem zu ersetzen, brächte einen identischen Inhalt bis auf
  `generatedAt` - und für nginx ein neues mtime ohne neuen Stand.
  """
  def write_unless_current(changed?, path \\ nil) do
    path = path || Application.fetch_env!(:timemachine, :timeline_path)

    if changed? or not File.exists?(path) do
      write(path)
    else
      :current
    end
  end

  @doc """
  Kompakte Darstellung: eine sortierte Wochenachse plus je Repository die
  Zählungen als Arrays. Objekte je Woche würden den Wochenschlüssel für jedes
  Repository wiederholen.

  Veröffentlicht werden ausschließlich **eigene** Commits. Fremde Commits -
  bei Forks die gesamte Upstream-Historie - bleiben in der Datenbank, aber
  nicht in der Datei: Der Slider zeigt, woran *du* wann gearbeitet hast. Ein
  Repository ohne einen einzigen eigenen Commit taucht deshalb gar nicht auf.
  """
  def build do
    # Nur sichtbare Repositories: was auf privat gestellt oder gelöscht wurde,
    # darf nicht in einer öffentlich ausgelieferten Datei landen.
    visible = History.visible_repositories()
    visible_ids = MapSet.new(visible, & &1.repo_id)

    activity =
      History.activity()
      |> Enum.filter(&(&1.commits_own > 0 and MapSet.member?(visible_ids, &1.repo_id)))

    by_repo = Enum.group_by(activity, & &1.repo_id)
    # Ein Fork, zu dem nichts beigetragen wurde, ist keine eigene Arbeit.
    repos = Enum.filter(visible, &Map.has_key?(by_repo, &1.repo_id))

    weeks =
      activity
      |> Enum.map(& &1.week_start)
      |> Enum.uniq()
      |> Enum.sort(Date)

    index = weeks |> Enum.with_index() |> Map.new()

    %{
      generatedAt: DateTime.utc_now() |> DateTime.to_iso8601(),
      weeks: Enum.map(weeks, &Date.to_iso8601/1),
      repos:
        Enum.map(repos, fn repo ->
          %{
            id: repo.repo_id,
            account: repo.account,
            name: repo.name,
            fullName: repo.full_name,
            fork: repo.fork,
            createdAt: repo.created_at && DateTime.to_iso8601(repo.created_at),
            # Nur belegte Wochen, als [wochenIndex, eigeneCommits].
            activity:
              by_repo
              |> Map.fetch!(repo.repo_id)
              |> Enum.sort_by(& &1.week_start, Date)
              |> Enum.map(&[Map.fetch!(index, &1.week_start), &1.commits_own])
          }
        end)
    }
  end
end
