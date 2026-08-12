defmodule Timemachine.Repo.Migrations.TrackVisibility do
  use Ecto.Migration

  def change do
    # Abwesenheit ist eine Information. `/users/:account/repos` liefert nur
    # öffentliche Repositories - verschwindet eines aus der Liste, wurde es auf
    # privat gestellt, gelöscht oder transferiert. Ohne diese Spalte bliebe es
    # in der materialisierten, öffentlich ausgelieferten Datei stehen.
    alter table(:repo) do
      add :disappeared_at, :utc_datetime
    end

    create index(:repo, [:disappeared_at])
  end
end
