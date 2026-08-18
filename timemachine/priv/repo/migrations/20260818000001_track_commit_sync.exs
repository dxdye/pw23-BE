defmodule Timemachine.Repo.Migrations.TrackCommitSync do
  use Ecto.Migration

  def change do
    # Merkt sich, bis zu welchem `pushed_at` die Commits eines Repositories
    # geholt wurden. Ohne diese Spalte lässt sich nicht unterscheiden, ob die
    # Historie fehlt oder nur leer ist - jeder Lauf müsste sie erneut holen.
    #
    # NULL heißt: für dieses Repository ist noch nie ein Backfill gelaufen.
    alter table(:repo) do
      add :synced_pushed_at, :utc_datetime
    end
  end
end
