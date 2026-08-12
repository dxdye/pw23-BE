defmodule Timemachine.DataCase do
  @moduledoc "Testfall mit transaktionaler Datenbank - jeder Test startet leer."

  use ExUnit.CaseTemplate

  using do
    quote do
      alias Timemachine.Repo
      import Ecto.Query
      import Timemachine.DataCase
    end
  end

  setup tags do
    pid = Ecto.Adapters.SQL.Sandbox.start_owner!(Timemachine.Repo, shared: not tags[:async])
    on_exit(fn -> Ecto.Adapters.SQL.Sandbox.stop_owner(pid) end)
    :ok
  end

  def utc(iso) do
    {:ok, dt, _} = DateTime.from_iso8601(iso)
    DateTime.truncate(dt, :second)
  end
end
