import Config

config :timemachine,
  accounts: ["dxdye", "d2tsb"],
  # Fünf Minuten, derselbe Takt wie der Deno-Cache. Ein Lauf ohne Änderung
  # kostet einen Request je Account und keinen einzigen je Repository - die
  # Liste kommt als 304, und ohne bewegtes pushed_at werden keine Commits
  # geholt. Mit Token ist ein 304 vom Kontingent befreit; ohne Token zählt er
  # mit, das sind bei zwei Accounts 24 der 60 Requests pro Stunde.
  poll_interval_ms: :timer.minutes(5),
  timeline_path: Path.expand("../data/timeline.json", __DIR__),
  # Für einmalige Tasks (Import, iex) abschaltbar, damit nicht jeder Aufruf
  # einen GitHub-Lauf auslöst.
  start_poller: System.get_env("START_POLLER") != "false"

config :logger, level: :debug
