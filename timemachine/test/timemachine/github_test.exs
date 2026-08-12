defmodule Timemachine.GitHubTest do
  @moduledoc "Reine Funktionen: Wochenraster und Autorenzuordnung, ohne Netz."
  use ExUnit.Case, async: true

  alias Timemachine.GitHub

  describe "week_start/1" do
    test "bildet auf den Sonntag der Woche ab" do
      # 1784419200 ist der Wochenstart, den GitHubs commit_activity liefert.
      sunday = DateTime.from_unix!(1_784_419_200)
      assert Date.to_iso8601(GitHub.week_start(sunday)) == "2026-07-19"
    end

    test "alle Tage einer Woche fallen auf denselben Sonntag" do
      for offset <- 0..6 do
        dt = DateTime.from_unix!(1_784_419_200 + offset * 86_400)
        assert Date.to_iso8601(GitHub.week_start(dt)) == "2026-07-19"
      end
    end

    test "der nächste Sonntag beginnt eine neue Woche" do
      dt = DateTime.from_unix!(1_784_419_200 + 7 * 86_400)
      assert Date.to_iso8601(GitHub.week_start(dt)) == "2026-07-26"
    end

    test "Samstag 23:59 UTC gehört noch zur alten Woche" do
      {:ok, dt, _} = DateTime.from_iso8601("2026-07-25T23:59:59Z")
      assert Date.to_iso8601(GitHub.week_start(dt)) == "2026-07-19"
    end
  end

  describe "own?/2" do
    test "erkennt den verknüpften Login, unabhängig von Groß-/Kleinschreibung" do
      assert GitHub.own?(%{"author" => %{"login" => "DxDye"}}, ["dxdye"])
      assert GitHub.own?(%{"author" => %{"login" => "dxdye"}}, ["dxdye", "d2tsb"])
    end

    test "fremde Logins zählen nicht als eigen" do
      refute GitHub.own?(%{"author" => %{"login" => "torvalds"}}, ["dxdye"])
    end

    test "fällt auf die noreply-Mail zurück, wenn kein Konto verknüpft ist" do
      commit = %{
        "author" => nil,
        "commit" => %{"author" => %{"email" => "dxdye@users.noreply.github.com"}}
      }

      assert GitHub.own?(commit, ["dxdye"])
    end

    test "erkennt das noreply-Format mit vorangestellter Konto-ID" do
      # Das aktuelle Format ist <id>+<login>@users.noreply.github.com.
      commit = %{
        "author" => nil,
        "commit" => %{"author" => %{"email" => "162121749+dxdye@users.noreply.github.com"}}
      }

      assert GitHub.own?(commit, ["dxdye"])
    end

    test "eine fremde noreply-Adresse zählt nicht als eigen" do
      commit = %{
        "author" => nil,
        "commit" => %{"author" => %{"email" => "999+torvalds@users.noreply.github.com"}}
      }

      refute GitHub.own?(commit, ["dxdye"])
    end

    test "erkennt konfigurierte Zusatzadressen" do
      # Commits mit Arbeits- oder Hochschulmail: GitHub verknüpft sie mit
      # keinem Konto, sie sind aber trotzdem eigene.
      commit = %{
        "author" => nil,
        "commit" => %{"author" => %{"email" => "Tilman.Bertram@campudus.com"}}
      }

      assert GitHub.own?(commit, ["dxdye"], ["tilman.bertram@campudus.com"])
      refute GitHub.own?(commit, ["dxdye"], [])
    end

    test "eine Adresse, die nur zufällig mit dem Login beginnt, zählt nicht" do
      # Früher genügte ein startsWith auf "<login>@" - das griff auch bei
      # fremden Domains.
      commit = %{
        "author" => nil,
        "commit" => %{"author" => %{"email" => "dxdye@fremde-domain.example"}}
      }

      refute GitHub.own?(commit, ["dxdye"], [])
    end

    test "ein verknüpfter fremder Login schlägt die Mail-Heuristik" do
      # Wichtig: der Login ist die verlässlichere Quelle. Wer hier auf die Mail
      # zurückfiele, würde Upstream-Commits in Forks als eigene zählen.
      commit = %{
        "author" => %{"login" => "someoneelse"},
        "commit" => %{"author" => %{"email" => "dxdye@users.noreply.github.com"}}
      }

      refute GitHub.own?(commit, ["dxdye"])
    end

    test "unbekannte Mail ohne Konto zählt nicht als eigen" do
      commit = %{"author" => nil, "commit" => %{"author" => %{"email" => "fremd@example.org"}}}
      refute GitHub.own?(commit, ["dxdye"])
    end

    test "fehlende Angaben zählen nicht als eigen" do
      refute GitHub.own?(%{}, ["dxdye"])
      refute GitHub.own?(%{"author" => nil, "commit" => %{}}, ["dxdye"])
    end
  end
end
