# Used by "mix format"
[
  # Ohne das setzt der Formatter Klammern um `field`, `add`, `create` &co.
  import_deps: [:ecto, :ecto_sql],
  subdirectories: ["priv/*/migrations"],
  inputs: ["{mix,.formatter}.exs", "{config,lib,test}/**/*.{ex,exs}"]
]
