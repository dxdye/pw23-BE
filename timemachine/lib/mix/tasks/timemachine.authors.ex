defmodule Mix.Tasks.Timemachine.Authors do
  @shortdoc "Zeigt, welche Commits keinem eigenen Account zugeordnet werden"

  @moduledoc """
  Diagnose für die Autoren-Zuordnung. Holt die Commits der erfassten
  Repositories und listet die Identitäten, die *nicht* als eigen gelten.

  Zweck: herausfinden, ob darunter noch eine eigene Adresse steckt, die in
  `GITHUB_EMAILS` fehlt. GitHub verknüpft Commits nur dann mit einem Konto,
  wenn die Commit-Mail dort hinterlegt ist - sonst steht `author: null`, und
  ohne Eintrag in `GITHUB_EMAILS` zählt der Commit als fremd.

  Speichert nichts. Fremde Mailadressen dauerhaft abzulegen, nur um diesen
  seltenen Fall zu bedienen, wäre der falsche Tausch - ein voller Neulauf des
  Backfills kostet rund 23 Requests.

      mix timemachine.authors              # alle erfassten Repositories
      mix timemachine.authors dxdye/dxdye  # nur eines
  """

  use Mix.Task

  alias Timemachine.{GitHub, History}

  @impl true
  def run(args) do
    Mix.Task.run("app.start")

    logins = Application.get_env(:timemachine, :accounts, [])
    emails = Application.get_env(:timemachine, :own_emails, [])

    repos =
      case args do
        [] -> History.visible_repositories() |> Enum.map(& &1.full_name)
        names -> names
      end

    Mix.shell().info("Accounts: #{Enum.join(logins, ", ")}")

    Mix.shell().info(
      "GITHUB_EMAILS: #{if emails == [], do: "(leer)", else: Enum.join(emails, ", ")}"
    )

    Mix.shell().info("")

    Enum.each(repos, &report(&1, logins))
  end

  defp report(full_name, logins) do
    case GitHub.authors(full_name, logins) do
      {:ok, authors} ->
        fremd = Enum.reject(authors, & &1.own)
        eigen = Enum.filter(authors, & &1.own)
        eigen_summe = Enum.reduce(eigen, 0, &(&1.commits + &2))
        fremd_summe = Enum.reduce(fremd, 0, &(&1.commits + &2))

        Mix.shell().info("#{full_name}  (#{eigen_summe} eigen / #{fremd_summe} fremd)")

        if fremd == [] do
          Mix.shell().info("  alles zugeordnet")
        else
          Enum.each(fremd, fn a ->
            login = if a.login == "", do: "-", else: a.login

            Mix.shell().info(
              "  #{String.pad_leading("#{a.commits}", 4)}x  login=#{String.pad_trailing(login, 14)} " <>
                "name=#{String.pad_trailing(a.name, 20)} #{a.email}"
            )
          end)
        end

        Mix.shell().info("")

      {:error, error} ->
        Mix.shell().error("#{full_name}: #{Exception.message(error)}")
    end
  end
end
