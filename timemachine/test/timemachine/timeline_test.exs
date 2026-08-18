defmodule Timemachine.TimelineTest do
  use Timemachine.DataCase, async: false

  alias Timemachine.{History, Timeline}

  defp add_repo(id, name, opts \\ []) do
    History.upsert_repository(%{
      repo_id: id,
      account: "dxdye",
      name: name,
      full_name: "dxdye/#{name}",
      fork: Keyword.get(opts, :fork, false),
      private: false,
      created_at: utc("2026-01-01T00:00:00Z")
    })
  end

  setup do
    add_repo(1, "eigen")
    add_repo(2, "geforkt_ohne_beitrag", fork: true)
    add_repo(3, "geforkt_mit_beitrag", fork: true)

    History.replace_weeks(1, nil, %{~D[2026-07-05] => {4, 4}, ~D[2026-07-19] => {2, 2}})
    # Fork ohne eigenen Beitrag: reine Upstream-Historie.
    History.replace_weeks(2, nil, %{~D[2026-07-12] => {9, 0}})
    # Fork mit eigenem Beitrag: gemischt.
    History.replace_weeks(3, nil, %{~D[2026-07-05] => {6, 2}, ~D[2026-06-28] => {3, 0}})
    :ok
  end

  test "die Wochenachse enthält nur Wochen mit eigenen Commits" do
    timeline = Timeline.build()

    # 2026-07-12 stammt allein aus dem Fork ohne eigenen Beitrag, 2026-06-28
    # aus fremden Commits im gemischten Fork - beide fallen weg.
    assert timeline.weeks == ["2026-07-05", "2026-07-19"]
  end

  test "ein Fork ohne eigene Commits taucht gar nicht auf" do
    timeline = Timeline.build()
    assert Enum.map(timeline.repos, & &1.id) |> Enum.sort() == [1, 3]
  end

  test "ein Fork mit eigenem Beitrag bleibt drin" do
    timeline = Timeline.build()
    fork = Enum.find(timeline.repos, &(&1.id == 3))

    assert fork.fork == true
    # Nur die Woche mit eigenem Anteil, und nur die eigene Zahl.
    assert fork.activity == [[0, 2]]
  end

  test "die Aktivität nennt nur eigene Commits" do
    timeline = Timeline.build()
    eigen = Enum.find(timeline.repos, &(&1.id == 1))

    # [wochenIndex, eigeneCommits] - fremde Zahlen werden nicht veröffentlicht.
    assert eigen.activity == [[0, 4], [1, 2]]
  end

  test "fremde Commit-Zahlen stehen nirgends in der Datei" do
    json = Timeline.build() |> Jason.encode!()

    # 9 und 6 sind reine Fremdzahlen aus dem Setup. Sie dürfen weder als
    # Zählung noch sonstwie in der ausgelieferten Datei auftauchen.
    refute json =~ ~r/\[\d+,\s*9\]/
    refute json =~ ~r/\[\d+,\s*6\]/
  end

  test "write/1 erzeugt gültiges JSON" do
    path = Path.join(System.tmp_dir!(), "timeline_#{System.unique_integer([:positive])}.json")
    on_exit(fn -> File.rm(path) end)

    assert {:ok, ^path, bytes} = Timeline.write(path)
    assert bytes > 0

    decoded = path |> File.read!() |> Jason.decode!()
    assert decoded["weeks"] == ["2026-07-05", "2026-07-19"]
    assert length(decoded["repos"]) == 2
  end

  test "write/1 hinterlässt keine Temp-Datei" do
    path = Path.join(System.tmp_dir!(), "timeline_#{System.unique_integer([:positive])}.json")
    on_exit(fn -> File.rm(path) end)

    Timeline.write(path)

    # Erst schreiben, dann rename: es darf nie eine halb geschriebene Datei
    # unter dem Zielnamen liegen.
    refute File.exists?(path <> ".tmp")
    assert File.exists?(path)
  end

  test "write/1 legt fehlende Verzeichnisse an" do
    dir = Path.join(System.tmp_dir!(), "tl_#{System.unique_integer([:positive])}")
    path = Path.join([dir, "nested", "timeline.json"])
    on_exit(fn -> File.rm_rf(dir) end)

    assert {:ok, ^path, _} = Timeline.write(path)
    assert File.exists?(path)
  end

  describe "write_unless_current/2" do
    setup do
      path = Path.join(System.tmp_dir!(), "timeline_#{System.unique_integer([:positive])}.json")
      on_exit(fn -> File.rm(path) end)
      {:ok, path: path}
    end

    test "ohne Änderung bleibt die Datei unangetastet", %{path: path} do
      assert {:ok, ^path, _} = Timeline.write(path)
      written = File.read!(path)

      assert :current = Timeline.write_unless_current(false, path)
      # Inhaltsvergleich statt mtime: generatedAt trägt Mikrosekunden, ein
      # zweiter Schreibvorgang wäre daran zu erkennen.
      assert File.read!(path) == written
    end

    test "mit Änderung wird geschrieben", %{path: path} do
      assert {:ok, ^path, bytes} = Timeline.write_unless_current(true, path)
      assert bytes > 0
    end

    test "eine fehlende Datei ist selbst Grund genug", %{path: path} do
      # Sonst stünde nach einem verlorenen Volume nie wieder eine Timeline da,
      # solange niemand etwas pusht.
      refute File.exists?(path)
      assert {:ok, ^path, _} = Timeline.write_unless_current(false, path)
      assert File.exists?(path)
    end
  end

  test "ein Repository ganz ohne Aktivität taucht nicht auf" do
    add_repo(4, "leer")

    timeline = Timeline.build()
    refute Enum.any?(timeline.repos, &(&1.id == 4))
  end
end
