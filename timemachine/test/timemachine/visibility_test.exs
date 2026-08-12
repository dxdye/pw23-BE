defmodule Timemachine.VisibilityTest do
  @moduledoc """
  Verhalten bei Sichtbarkeitswechseln.

  `/users/:account/repos` liefert nur öffentliche Repositories. Ein Repository
  verschwindet aus der Liste, wenn es auf privat gestellt, gelöscht oder
  transferiert wurde - und darf dann nicht weiter in einer öffentlich
  ausgelieferten Datei stehen.
  """

  use Timemachine.DataCase, async: false

  alias Timemachine.{History, Poller, Timeline}
  alias Timemachine.Schema.{Repository, RepoState}

  defp add_repo(repo_id, name, account \\ "dxdye", observed_at \\ "2026-07-01T00:00:00Z") do
    History.upsert_repository(%{
      repo_id: repo_id,
      account: account,
      name: name,
      full_name: "#{account}/#{name}",
      fork: false,
      private: false,
      created_at: utc("2026-01-01T00:00:00Z")
    })

    History.record_state(
      repo_id,
      %{
        pushed_at: utc("2026-07-01T00:00:00Z"),
        stars: 1,
        forks: 0,
        size_kb: 10,
        language: "Elixir",
        archived: false
      },
      utc(observed_at)
    )

    History.replace_weeks(repo_id, nil, %{~D[2026-07-05] => {5, 5}})
  end

  describe "öffentlich -> privat" do
    setup do
      add_repo(1, "bleibt")
      add_repo(2, "wird_privat")
      :ok
    end

    test "das fehlende Repository verschwindet aus der Timeline" do
      # Erfolgreiche Liste, in der Repo 2 fehlt.
      assert [2] = Poller.reconcile([{"dxdye", {:ok, [1]}}], utc("2026-08-01T00:00:00Z"))

      timeline = Timeline.build()
      assert Enum.map(timeline.repos, & &1.id) == [1]
    end

    test "auch seine Aktivität wird nicht mehr veröffentlicht" do
      Poller.reconcile([{"dxdye", {:ok, [1]}}], utc("2026-08-01T00:00:00Z"))

      timeline = Timeline.build()
      # Die Wochenachse darf keine Woche enthalten, die nur von Repo 2 stammt.
      refute Enum.any?(timeline.repos, &(&1.id == 2))
      assert timeline.weeks == ["2026-07-05"]
    end

    test "das offene Zustandsintervall wird geschlossen" do
      Poller.reconcile([{"dxdye", {:ok, [1]}}], utc("2026-08-01T00:00:00Z"))

      state = Repo.get_by(RepoState, repo_id: 2)
      assert state.valid_to == utc("2026-08-01T00:00:00Z")
    end

    test "state_at liefert es für die Zeit danach nicht mehr" do
      Poller.reconcile([{"dxdye", {:ok, [1]}}], utc("2026-08-01T00:00:00Z"))

      before = History.state_at(utc("2026-07-15T00:00:00Z")) |> Enum.map(& &1.repo_id)
      after_ = History.state_at(utc("2026-08-15T00:00:00Z")) |> Enum.map(& &1.repo_id)

      # Vorher war der Zustand bekannt, danach nicht mehr - das ist keine
      # Lücke im Datenmodell, sondern die korrekte Aussage.
      assert 2 in before
      refute 2 in after_
    end

    test "die Daten bleiben in der Datenbank" do
      Poller.reconcile([{"dxdye", {:ok, [1]}}], utc("2026-08-01T00:00:00Z"))

      # Nur der Materialisierer lässt sie aus; eine Rückkehr kostet dann nichts.
      assert Repo.get(Repository, 2)
      assert length(History.repositories()) == 2
      assert length(History.visible_repositories()) == 1
    end
  end

  describe "privat -> öffentlich" do
    test "ein zurückkehrendes Repository wird wieder sichtbar" do
      add_repo(1, "kommt_zurueck")
      Poller.reconcile([{"dxdye", {:ok, []}}], utc("2026-08-01T00:00:00Z"))
      assert History.visible_repositories() == []

      # Taucht wieder in der Liste auf: upsert setzt disappeared_at zurück.
      add_repo(1, "kommt_zurueck", "dxdye", "2026-09-01T00:00:00Z")

      assert [%{repo_id: 1}] = History.visible_repositories()
      assert Enum.map(Timeline.build().repos, & &1.id) == [1]
    end

    test "die Rückkehr öffnet ein neues Intervall und lässt die Lücke stehen" do
      add_repo(1, "kommt_zurueck")
      Poller.reconcile([{"dxdye", {:ok, []}}], utc("2026-08-01T00:00:00Z"))
      add_repo(1, "kommt_zurueck", "dxdye", "2026-09-01T00:00:00Z")

      intervals =
        Repo.all(RepoState)
        |> Enum.filter(&(&1.repo_id == 1))
        |> Enum.sort_by(& &1.valid_from, DateTime)
        |> Enum.map(&{&1.valid_from, &1.valid_to})

      # Zwei Intervalle mit einer Lücke dazwischen - während der privaten Zeit
      # war der Zustand tatsächlich unbekannt.
      assert [
               {~U[2026-07-01 00:00:00Z], ~U[2026-08-01 00:00:00Z]},
               {~U[2026-09-01 00:00:00Z], nil}
             ] = intervals

      assert History.state_at(utc("2026-08-15T00:00:00Z")) == []
    end

    test "Verschwinden und Rückkehr in derselben Sekunde kollidiert nicht" do
      # Der Unique-Index liegt auf (repo_id, valid_from). Ohne Konfliktauflösung
      # scheitert der Insert, wenn beide Beobachtungen auf dieselbe Sekunde
      # fallen.
      add_repo(1, "flackert")
      Poller.reconcile([{"dxdye", {:ok, []}}], utc("2026-07-01T00:00:00Z"))

      add_repo(1, "flackert", "dxdye", "2026-07-01T00:00:00Z")

      assert [%{repo_id: 1}] = History.visible_repositories()
      assert [state] = Repo.all(RepoState) |> Enum.filter(&(&1.repo_id == 1))
      assert is_nil(state.valid_to)
    end

    test "ein neues Repository bringt seine volle Commit-Historie mit" do
      # Commits tragen ihr eigenes Datum: die Aktivität reicht zurück, auch
      # wenn das Repository erst heute öffentlich wurde.
      History.upsert_repository(%{
        repo_id: 9,
        account: "dxdye",
        name: "frisch_oeffentlich",
        full_name: "dxdye/frisch_oeffentlich",
        fork: false,
        private: false,
        created_at: utc("2024-01-01T00:00:00Z")
      })

      History.replace_weeks(9, nil, %{~D[2024-02-04] => {3, 3}, ~D[2026-07-05] => {1, 1}})

      timeline = Timeline.build()
      assert timeline.weeks == ["2024-02-04", "2026-07-05"]
    end
  end

  describe "reconcile/2 räumt nur bei belastbarer Information auf" do
    setup do
      add_repo(1, "eins")
      add_repo(2, "zwei")
      :ok
    end

    test "ein Fehler löscht nichts" do
      error = %Timemachine.GitHub.Error{status: 500, message: "boom"}
      assert [] = Poller.reconcile([{"dxdye", {:error, error}}])
      assert length(History.visible_repositories()) == 2
    end

    test "304 löscht nichts" do
      # not_modified heißt "unverändert", nicht "leer".
      assert [] = Poller.reconcile([{"dxdye", :not_modified}])
      assert length(History.visible_repositories()) == 2
    end

    test "ein Account mit Fehler beeinflusst den anderen nicht" do
      add_repo(3, "fremd", "d2tsb")
      error = %Timemachine.GitHub.Error{status: 500, message: "boom"}

      missing = Poller.reconcile([{"dxdye", {:ok, [1, 2]}}, {"d2tsb", {:error, error}}])

      assert missing == []
      assert length(History.visible_repositories()) == 3
    end

    test "ein Transfer zwischen konfigurierten Accounts gilt nicht als verschwunden" do
      add_repo(1, "wandert")
      # Nach dem Transfer steht Repo 1 unter d2tsb - upsert hat den Account
      # bereits umgeschrieben, bevor aufgeräumt wird.
      add_repo(1, "wandert", "d2tsb")

      missing = Poller.reconcile([{"dxdye", {:ok, [2]}}, {"d2tsb", {:ok, [1]}}])

      assert missing == []
      assert length(History.visible_repositories()) == 2
    end
  end

  describe "mark_disappeared/2" do
    test "ist idempotent" do
      add_repo(1, "eins")
      {:ok, first} = History.mark_disappeared([1], utc("2026-08-01T00:00:00Z"))
      {:ok, second} = History.mark_disappeared([1], utc("2026-08-02T00:00:00Z"))

      assert first == 1
      assert second == 0
      # Der ursprüngliche Zeitpunkt bleibt stehen.
      assert Repo.get(Repository, 1).disappeared_at == utc("2026-08-01T00:00:00Z")
    end

    test "eine leere Liste tut nichts" do
      add_repo(1, "eins")
      assert {:ok, 0} = History.mark_disappeared([])
      assert length(History.visible_repositories()) == 1
    end
  end
end
