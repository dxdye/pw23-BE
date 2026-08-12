defmodule Mix.Tasks.Timemachine.Import do
  @shortdoc "Importiert die Ausgabe des TypeScript-Backfills"

  @moduledoc """
  Liest `data/backfill.json` aus dem Backfill-Skript und schreibt sie in die
  Historie. Damit muss die einmalige Vollhistorie nicht ein zweites Mal von
  GitHub geholt werden.

      mix timemachine.import ../data/backfill.json
  """

  use Mix.Task

  alias Timemachine.{History, Timeline}

  @impl true
  def run(args) do
    Mix.Task.run("app.start")
    path = List.first(args) || "../data/backfill.json"

    data = path |> File.read!() |> Jason.decode!()
    activity_by_repo = Enum.group_by(data["activity"], & &1["repo_id"])

    for repo <- data["repos"] do
      History.upsert_repository(%{
        repo_id: repo["repo_id"],
        account: repo["account"],
        name: repo["name"],
        full_name: repo["full_name"],
        fork: !!repo["fork"],
        private: !!repo["private"],
        created_at: parse(repo["created_at"])
      })

      History.record_state(repo["repo_id"], %{
        pushed_at: parse(repo["pushed_at"]),
        stars: 0,
        forks: 0,
        size_kb: repo["size"] || 0,
        language: repo["language"],
        archived: !!repo["archived"]
      })

      counts =
        activity_by_repo
        |> Map.get(repo["repo_id"], [])
        |> Map.new(fn row ->
          {Date.from_iso8601!(row["week_start"]), {row["commits"], row["commits_own"] || 0}}
        end)

      History.replace_weeks(repo["repo_id"], nil, counts)
    end

    {:ok, out, bytes} = Timeline.write()

    Mix.shell().info(
      "#{length(data["repos"])} Repos, #{length(data["activity"])} Wochen importiert"
    )

    Mix.shell().info("timeline: #{out} (#{bytes} bytes)")
  end

  defp parse(nil), do: nil

  defp parse(raw) do
    case DateTime.from_iso8601(raw) do
      {:ok, dt, _} -> DateTime.truncate(dt, :second)
      _ -> nil
    end
  end
end
