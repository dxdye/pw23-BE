import Config

# Nur zur Laufzeit gelesen, damit ein `mix release` ohne Rebuild
# umkonfiguriert werden kann.
if config_env() == :prod do
  config :timemachine, Timemachine.Repo,
    database: System.get_env("DATABASE_PATH") || "/app/data/timemachine.db",
    journal_mode: :wal

  config :timemachine,
    accounts:
      (System.get_env("GITHUB_ACCOUNTS") || "dxdye")
      |> String.split(",", trim: true)
      |> Enum.map(&String.trim/1),
    poll_interval_ms: String.to_integer(System.get_env("POLL_INTERVAL_MS") || "3600000"),
    timeline_path: System.get_env("TIMELINE_PATH") || "/app/data/timeline.json",
    start_poller: System.get_env("START_POLLER") != "false"
end

# Der Token wird in jeder Umgebung aus der Umgebung gelesen, nie aus einer
# eingecheckten Datei.
config :timemachine,
  github_token: System.get_env("GITHUB_TOKEN"),
  # Commit-Mails, die nicht im GitHub-Konto hinterlegt sind. Ohne sie zaehlen
  # eigene Commits als fremde, weil GitHub sie keinem Konto zuordnet.
  own_emails:
    (System.get_env("GITHUB_EMAILS") || "")
    |> String.split(",", trim: true)
    |> Enum.map(&String.trim/1)
