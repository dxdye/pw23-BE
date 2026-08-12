defmodule Timemachine.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children =
      [Timemachine.Repo] ++
        if Application.get_env(:timemachine, :start_poller, true),
          do: [Timemachine.Poller],
          else: []

    # :one_for_one - stirbt der Poller an einem GitHub-Fehler, wird nur er
    # neu gestartet; die Datenbankverbindung bleibt bestehen.
    Supervisor.start_link(children, strategy: :one_for_one, name: Timemachine.Supervisor)
  end
end
