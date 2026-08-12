import Config

config :timemachine,
  accounts: ["dxdye"],
  poll_interval_ms: :timer.hours(1),
  timeline_path: Path.expand("../tmp/timeline_test.json", __DIR__),
  # Der Poller würde im Test gegen die echte API laufen.
  start_poller: false

config :timemachine, Timemachine.Repo,
  database: Path.expand("../data/timemachine_test.db", __DIR__),
  pool: Ecto.Adapters.SQL.Sandbox

config :logger, level: :warning
