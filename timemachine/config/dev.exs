import Config

config :timemachine,
  accounts: ["dxdye", "d2tsb"],
  # Stündlich. Mit Token und ETags kosten unveränderte Läufe kein Kontingent;
  # ohne Token zählt auch ein 304 mit.
  poll_interval_ms: :timer.hours(1),
  timeline_path: Path.expand("../data/timeline.json", __DIR__),
  # Für einmalige Tasks (Import, iex) abschaltbar, damit nicht jeder Aufruf
  # einen GitHub-Lauf auslöst.
  start_poller: System.get_env("START_POLLER") != "false"

config :logger, level: :debug
