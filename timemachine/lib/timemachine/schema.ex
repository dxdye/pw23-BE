defmodule Timemachine.Schema.Repository do
  @moduledoc "Dimensionstabelle: ein Eintrag je Repository, Schlüssel ist GitHubs id."
  use Ecto.Schema

  @primary_key {:repo_id, :integer, autogenerate: false}
  schema "repo" do
    field :account, :string
    field :name, :string
    field :full_name, :string
    field :fork, :boolean, default: false
    field :private, :boolean, default: false
    field :created_at, :utc_datetime
    # nil = derzeit öffentlich sichtbar. Sonst der Zeitpunkt, zu dem das
    # Repository aus der GitHub-Liste verschwand.
    field :disappeared_at, :utc_datetime
    # Das `pushed_at`, bis zu dem die Commits geholt wurden. nil = noch nie.
    field :synced_pushed_at, :utc_datetime

    timestamps(type: :utc_datetime)
  end
end

defmodule Timemachine.Schema.RepoState do
  @moduledoc "Zustand eines Repositories über ein Gültigkeitsintervall (SCD-2)."
  use Ecto.Schema

  @primary_key false
  schema "repo_state" do
    field :repo_id, :integer
    field :valid_from, :utc_datetime
    field :valid_to, :utc_datetime
    field :pushed_at, :utc_datetime
    field :stars, :integer
    field :forks, :integer
    field :size_kb, :integer
    field :language, :string
    field :archived, :boolean
    field :fingerprint, :integer
  end
end

defmodule Timemachine.Schema.RepoActivity do
  @moduledoc "Commits je Repository und Woche."
  use Ecto.Schema

  @primary_key false
  schema "repo_activity" do
    field :repo_id, :integer
    field :week_start, :date
    field :commits, :integer, default: 0
    field :commits_own, :integer, default: 0
  end
end

defmodule Timemachine.Schema.HttpCache do
  @moduledoc "ETag je URL für Conditional Requests."
  use Ecto.Schema

  @primary_key {:url, :string, autogenerate: false}
  schema "http_cache" do
    field :etag, :string
    field :fetched_at, :utc_datetime
  end
end
