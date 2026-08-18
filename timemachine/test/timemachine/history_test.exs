defmodule Timemachine.HistoryTest do
  use Timemachine.DataCase, async: true

  alias Timemachine.History
  alias Timemachine.Schema.{RepoActivity, RepoState}

  @repo_id 4711

  defp repo_attrs(overrides \\ %{}) do
    Map.merge(
      %{
        repo_id: @repo_id,
        account: "dxdye",
        name: "demo",
        full_name: "dxdye/demo",
        fork: false,
        private: false,
        created_at: utc("2025-01-01T00:00:00Z")
      },
      overrides
    )
  end

  defp state_attrs(overrides \\ %{}) do
    Map.merge(
      %{
        pushed_at: utc("2026-07-01T00:00:00Z"),
        stars: 3,
        forks: 1,
        size_kb: 1234,
        language: "Elixir",
        archived: false
      },
      overrides
    )
  end

  describe "upsert_repository/1" do
    test "legt an und aktualisiert danach denselben Schlüssel" do
      :ok = History.upsert_repository(repo_attrs())

      :ok =
        History.upsert_repository(repo_attrs(%{name: "umbenannt", full_name: "dxdye/umbenannt"}))

      # Eine Umbenennung ist ein normales Update, kein Bruch der Historie:
      # der Schlüssel ist GitHubs id, nicht der Name.
      assert [repo] = History.repositories()
      assert repo.repo_id == @repo_id
      assert repo.name == "umbenannt"
    end
  end

  describe "record_state/3" do
    test "der erste Zustand öffnet ein Intervall" do
      :ok = History.upsert_repository(repo_attrs())
      assert :changed = History.record_state(@repo_id, state_attrs(), utc("2026-07-01T00:00:00Z"))

      assert [state] = Repo.all(RepoState)
      assert state.valid_from == utc("2026-07-01T00:00:00Z")
      assert is_nil(state.valid_to)
      assert state.stars == 3
    end

    test "unveränderte Werte erzeugen keine neue Zeile" do
      :ok = History.upsert_repository(repo_attrs())
      History.record_state(@repo_id, state_attrs(), utc("2026-07-01T00:00:00Z"))

      assert :unchanged =
               History.record_state(@repo_id, state_attrs(), utc("2026-07-02T00:00:00Z"))

      # Genau das ist die zeitliche Deduplikation: keine Änderung, keine Zeile.
      assert [_only_one] = Repo.all(RepoState)
    end

    test "eine Änderung schließt das alte Intervall und öffnet ein neues" do
      :ok = History.upsert_repository(repo_attrs())
      History.record_state(@repo_id, state_attrs(), utc("2026-07-01T00:00:00Z"))

      assert :changed =
               History.record_state(
                 @repo_id,
                 state_attrs(%{stars: 9}),
                 utc("2026-07-05T00:00:00Z")
               )

      states = Repo.all(RepoState) |> Enum.sort_by(& &1.valid_from, DateTime)
      assert [old, new] = states
      assert old.valid_to == utc("2026-07-05T00:00:00Z")
      assert old.stars == 3
      assert is_nil(new.valid_to)
      assert new.stars == 9
    end

    test "erkennt Änderungen unabhängig von GitHubs updated_at" do
      :ok = History.upsert_repository(repo_attrs())
      History.record_state(@repo_id, state_attrs(), utc("2026-07-01T00:00:00Z"))

      # Nur die Sprache wechselt - updated_at spielt für den Vergleich keine
      # Rolle, weil der Hash nur über die gespeicherten Felder geht.
      assert :changed =
               History.record_state(
                 @repo_id,
                 state_attrs(%{language: "Rust"}),
                 utc("2026-07-06T00:00:00Z")
               )
    end
  end

  describe "state_at/1" do
    setup do
      :ok = History.upsert_repository(repo_attrs())
      History.record_state(@repo_id, state_attrs(%{stars: 1}), utc("2026-01-01T00:00:00Z"))
      History.record_state(@repo_id, state_attrs(%{stars: 5}), utc("2026-06-01T00:00:00Z"))
      :ok
    end

    test "liefert den Zustand, der zum Zeitpunkt galt" do
      assert [%{stars: 1}] = History.state_at(utc("2026-03-01T00:00:00Z"))
      assert [%{stars: 5}] = History.state_at(utc("2026-08-01T00:00:00Z"))
    end

    test "die Intervallgrenze gehört zum neuen Zustand" do
      assert [%{stars: 5}] = History.state_at(utc("2026-06-01T00:00:00Z"))
    end

    test "vor dem ersten Intervall gibt es nichts" do
      assert [] = History.state_at(utc("2025-12-31T00:00:00Z"))
    end
  end

  describe "replace_weeks/3" do
    test "schreibt die Wochen" do
      counts = %{~D[2026-07-05] => {3, 3}, ~D[2026-07-12] => {7, 2}}
      :ok = History.replace_weeks(@repo_id, nil, counts)

      rows = Repo.all(RepoActivity) |> Enum.sort_by(& &1.week_start, Date)
      assert [%{commits: 3, commits_own: 3}, %{commits: 7, commits_own: 2}] = rows
    end

    test "ein zweiter Lauf zählt nicht doppelt" do
      counts = %{~D[2026-07-05] => {3, 3}}
      :ok = History.replace_weeks(@repo_id, nil, counts)
      :ok = History.replace_weeks(@repo_id, nil, counts)

      # Ersetzen statt Hochzählen - sonst würde jeder überlappende Poll die
      # Zahlen aufblähen.
      assert [%{commits: 3}] = Repo.all(RepoActivity)
    end

    test "ersetzt nur ab der angegebenen Woche" do
      :ok =
        History.replace_weeks(@repo_id, nil, %{
          ~D[2026-06-28] => {5, 5},
          ~D[2026-07-05] => {3, 3}
        })

      :ok = History.replace_weeks(@repo_id, ~D[2026-07-05], %{~D[2026-07-05] => {9, 9}})

      rows = Repo.all(RepoActivity) |> Enum.sort_by(& &1.week_start, Date)

      assert [
               %{week_start: ~D[2026-06-28], commits: 5},
               %{week_start: ~D[2026-07-05], commits: 9}
             ] =
               rows
    end
  end

  describe "commits_synced?/2" do
    setup do
      :ok = History.upsert_repository(repo_attrs())
      :ok
    end

    test "ohne je gelaufenen Abgleich ist nichts synchron" do
      # Das ist der Fall, in dem der Backfill laufen muss.
      refute History.commits_synced?(@repo_id, utc("2026-07-01T00:00:00Z"))
    end

    test "nach dem Abgleich gilt genau dieses pushed_at als erledigt" do
      pushed = utc("2026-07-01T00:00:00Z")
      :ok = History.mark_commits_synced(@repo_id, pushed)

      assert History.commits_synced?(@repo_id, pushed)
    end

    test "ein neuer Push macht den Abgleich fällig" do
      :ok = History.mark_commits_synced(@repo_id, utc("2026-07-01T00:00:00Z"))

      refute History.commits_synced?(@repo_id, utc("2026-07-02T00:00:00Z"))
    end

    test "ein leeres Repository gilt trotzdem als abgeglichen" do
      # Es hinterlässt keine Woche - ohne die eigene Spalte wäre es von einem
      # nie geholten Repository nicht zu unterscheiden und würde bei jedem
      # Lauf erneut geholt.
      pushed = utc("2026-07-01T00:00:00Z")
      :ok = History.mark_commits_synced(@repo_id, pushed)

      assert is_nil(History.latest_week(@repo_id))
      assert History.commits_synced?(@repo_id, pushed)
    end

    test "ohne pushed_at wird abgeglichen statt geraten" do
      :ok = History.mark_commits_synced(@repo_id, utc("2026-07-01T00:00:00Z"))

      refute History.commits_synced?(@repo_id, nil)
    end

    test "ein unbekanntes Repository ist nicht synchron" do
      refute History.commits_synced?(999_999, utc("2026-07-01T00:00:00Z"))
    end

    test "der Vermerk überlebt einen Upsert" do
      pushed = utc("2026-07-01T00:00:00Z")
      :ok = History.mark_commits_synced(@repo_id, pushed)

      # Jeder Lauf schreibt die Stammdaten neu - der Abgleichstand darf dabei
      # nicht verloren gehen, sonst holt jeder Lauf alles erneut.
      :ok = History.upsert_repository(repo_attrs(%{name: "umbenannt"}))

      assert History.commits_synced?(@repo_id, pushed)
    end
  end

  describe "latest_week/1" do
    test "nil, solange nichts erfasst ist" do
      assert is_nil(History.latest_week(@repo_id))
    end

    test "liefert die jüngste Woche" do
      :ok =
        History.replace_weeks(@repo_id, nil, %{
          ~D[2026-06-28] => {1, 1},
          ~D[2026-07-12] => {1, 1}
        })

      assert History.latest_week(@repo_id) == ~D[2026-07-12]
    end
  end
end
