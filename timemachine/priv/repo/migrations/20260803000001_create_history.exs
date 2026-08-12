defmodule Timemachine.Repo.Migrations.CreateHistory do
  use Ecto.Migration

  def change do
    # Dimensionstabelle. Schlüssel ist GitHubs numerische id, nicht der Name:
    # Repos werden umbenannt, und bei einem Schlüssel auf dem Namen sähe eine
    # Umbenennung aus wie "gelöscht + neu angelegt" - die Historie risse genau
    # an der interessanten Stelle ab (Plan §2.1).
    create table(:repo, primary_key: false) do
      add :repo_id, :integer, primary_key: true
      add :account, :string, null: false
      add :name, :string, null: false
      add :full_name, :string, null: false
      add :fork, :boolean, null: false, default: false
      add :private, :boolean, null: false, default: false
      add :created_at, :utc_datetime

      timestamps(type: :utc_datetime)
    end

    create index(:repo, [:account])

    # Slowly Changing Dimension Type 2: eine Zeile je Zustand, mit
    # Gültigkeitsintervall. Nur bei Änderung entsteht eine neue Zeile, und der
    # Zustand zu einem Zeitpunkt T ist ein indizierter Zugriff statt eines
    # Delta-Replays (Plan §2.2).
    create table(:repo_state, primary_key: false) do
      add :repo_id, :integer, null: false
      add :valid_from, :utc_datetime, null: false
      add :valid_to, :utc_datetime
      add :pushed_at, :utc_datetime
      add :stars, :integer
      add :forks, :integer
      add :size_kb, :integer
      add :language, :string
      add :archived, :boolean
      # Hash über genau die Felder, die hier stehen. GitHubs updated_at reagiert
      # auch auf Ereignisse, die für die Relevanz belanglos sind (Plan §2.5).
      add :fingerprint, :integer, null: false
    end

    create unique_index(:repo_state, [:repo_id, :valid_from])
    create index(:repo_state, [:repo_id, :valid_to])

    # Trägt den Slider. Zwei Zahlen, weil Forks die Upstream-Historie
    # mitbringen: welche davon die Relevanz-Achse trägt, entscheidet der
    # Materialisierer, nicht das Schema.
    create table(:repo_activity, primary_key: false) do
      add :repo_id, :integer, null: false
      add :week_start, :date, null: false
      add :commits, :integer, null: false, default: 0
      add :commits_own, :integer, null: false, default: 0
    end

    create unique_index(:repo_activity, [:repo_id, :week_start])

    # ETags für Conditional Requests. Eine 304-Antwort ist nur bei
    # authentifizierten Requests vom Rate Limit befreit.
    create table(:http_cache, primary_key: false) do
      add :url, :string, primary_key: true
      add :etag, :string
      add :fetched_at, :utc_datetime
    end
  end
end
