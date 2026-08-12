import Config

config :timemachine,
  ecto_repos: [Timemachine.Repo]

config :timemachine, Timemachine.Repo,
  database: Path.expand("../data/timemachine_#{config_env()}.db", __DIR__),
  pool_size: 5,
  # Ohne WAL blockiert der Poller beim Schreiben den Materialisierer.
  journal_mode: :wal

config :logger, :console,
  format: "$time [$level] $message\n",
  metadata: [:account, :repo]

import_config "#{config_env()}.exs"
