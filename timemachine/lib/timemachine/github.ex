defmodule Timemachine.GitHub do
  @moduledoc """
  GitHub-Client für den Schreibpfad.

  Zwei Eigenschaften sind hier wesentlich: Conditional Requests über
  gespeicherte ETags und strikt sequenzielle Aufrufe - parallele Requests lösen
  die Missbrauchserkennung aus, unabhängig vom primären Kontingent (Plan
  §3.3.2).

  Zum ETag-Nutzen: eine 304-Antwort ist laut GitHub nur dann vom Rate Limit
  befreit, wenn der Request einen `Authorization`-Header trug. Ohne Token
  kostet auch ein 304 einen Request - nachgemessen: Kontingent von 10 auf 9.
  Der Poller spart das Kontingent also erst mit Token; ohne ihn spart er nur
  Übertragung.

  `stats/commit_activity` wird bewusst nicht verwendet: der Endpunkt kennt keine
  Autoren-Unterscheidung, reicht nur 52 Wochen zurück und antwortet beim ersten
  Aufruf mit 202, was gemessen vier Wiederholungen je Repository kostete.
  """

  require Logger

  alias Timemachine.Repo
  alias Timemachine.Schema.HttpCache

  @base "https://api.github.com"
  @per_page 100
  @max_pages 40
  # Pause zwischen Requests, gegen das sekundäre Limit.
  @delay_ms 150

  defmodule Error do
    defexception [:status, :message, :retry_after_ms]

    @impl true
    def message(%{status: status, message: message}), do: "GitHub #{status}: #{message}"
  end

  @doc """
  Repositories eines Accounts. `{:ok, repos}` oder `:not_modified`, wenn sich
  seit dem gespeicherten ETag nichts geändert hat.
  """
  def list_repos(account) do
    url = "/users/#{account}/repos?per_page=#{@per_page}&page=1&sort=created"

    case request(url, etag_for(url)) do
      {:not_modified, _} ->
        :not_modified

      {:ok, body, etag} when is_list(body) ->
        # Nur bei genau einer Seite ist der ETag für den Gesamtstand
        # aussagekräftig; sonst deckt er nur Seite 1 ab.
        if length(body) < @per_page do
          store_etag(url, etag)
          {:ok, Enum.map(body, &to_repo/1)}
        else
          store_etag(url, nil)
          {:ok, list_remaining_pages(account, body)}
        end

      {:ok, other, _} ->
        {:error, %Error{status: 200, message: "expected a list, got #{inspect(other)}"}}

      {:error, error} ->
        {:error, error}
    end
  end

  defp list_remaining_pages(account, first_page) do
    Enum.reduce_while(2..@max_pages, Enum.map(first_page, &to_repo/1), fn page, acc ->
      url = "/users/#{account}/repos?per_page=#{@per_page}&page=#{page}&sort=created"

      case request(url, nil) do
        {:ok, body, _} when is_list(body) ->
          acc = acc ++ Enum.map(body, &to_repo/1)
          if length(body) < @per_page, do: {:halt, acc}, else: {:cont, acc}

        _ ->
          {:halt, acc}
      end
    end)
  end

  defp to_repo(raw) do
    %{
      repo_id: raw["id"],
      account: get_in(raw, ["owner", "login"]),
      name: raw["name"],
      full_name: raw["full_name"],
      fork: !!raw["fork"],
      private: !!raw["private"],
      created_at: parse_time(raw["created_at"]),
      # Für den Zustandsvergleich, nicht für die Dimensionstabelle:
      state: %{
        pushed_at: parse_time(raw["pushed_at"]),
        stars: raw["stargazers_count"] || 0,
        forks: raw["forks_count"] || 0,
        size_kb: raw["size"] || 0,
        language: raw["language"],
        archived: !!raw["archived"]
      }
    }
  end

  @doc """
  Commits des Default-Branch, optional erst ab `since`.

  Ungefiltert geholt und lokal zugeordnet: ein Durchlauf liefert damit
  Gesamt- und Eigenanteil, statt zwei getrennte Abfragen zu brauchen. Bei einem
  Fork ist der Gesamtanteil die Upstream-Historie.

  Die Woche stammt aus dem **Author**-Datum - sie soll aussagen, wann gearbeitet
  wurde, nicht wann es gelandet ist. Achtung: `since` filtert nach
  **Committer**-Datum (nachgemessen). Nach einem Rebase kann diese Funktion
  deshalb Wochen liefern, die vor `since` liegen; wer inkrementell schreibt,
  muss das behandeln - siehe `Timemachine.Poller`.

  Gibt `{:ok, %{~D[...] => {commits, commits_own}}}` zurück.
  """
  def weekly_commits(full_name, own_logins, since \\ nil) do
    reduce_commits(full_name, since, %{}, &tally(&1, &2, own_logins))
  end

  @doc """
  Diagnose: welche Autoren-Identitäten stecken in einem Repository und welche
  davon gelten als eigen.

  Speichert bewusst nichts. Der einzige Zweck ist herauszufinden, ob unter den
  nicht zugeordneten Commits noch eine eigene Adresse steckt, die in
  `GITHUB_EMAILS` fehlt - fremde Mailadressen dauerhaft abzulegen, nur um diesen
  seltenen Fall zu bedienen, wäre der falsche Tausch.

  Gibt `{:ok, [%{login:, email:, name:, commits:, own:}]}` zurück.
  """
  def authors(full_name, own_logins) do
    with {:ok, tallied} <- reduce_commits(full_name, nil, %{}, &tally_author(&1, &2, own_logins)) do
      {:ok,
       tallied
       |> Enum.map(fn {{login, email}, %{name: name, commits: n, own: own}} ->
         %{login: login, email: email, name: name, commits: n, own: own}
       end)
       |> Enum.sort_by(& &1.commits, :desc)}
    end
  end

  # Paginiert über die Commit-Liste und faltet jeden Commit in `acc`. Von
  # weekly_commits und authors geteilt, damit es nur eine Paginierung gibt.
  defp reduce_commits(full_name, since, initial, fun) do
    since_param = if since, do: "&since=#{DateTime.to_iso8601(since)}", else: ""

    Enum.reduce_while(1..@max_pages, {:ok, initial}, fn page, {:ok, acc} ->
      url = "/repos/#{full_name}/commits?per_page=#{@per_page}&page=#{page}#{since_param}"

      case request(url, nil) do
        # 409 = leeres Repository, 404 = kein Zugriff.
        {:error, %Error{status: status}} when status in [404, 409] ->
          {:halt, {:ok, acc}}

        {:error, error} ->
          {:halt, {:error, error}}

        {:ok, body, _} when is_list(body) ->
          acc = Enum.reduce(body, acc, fun)
          if length(body) < @per_page, do: {:halt, {:ok, acc}}, else: {:cont, {:ok, acc}}

        {:ok, _, _} ->
          {:halt, {:ok, acc}}
      end
    end)
  end

  defp tally_author(commit, acc, own_logins) do
    login = get_in(commit, ["author", "login"]) || ""
    email = (get_in(commit, ["commit", "author", "email"]) || "") |> String.downcase()
    name = get_in(commit, ["commit", "author", "name"]) || ""
    own = own?(commit, own_logins)

    Map.update(
      acc,
      {login, email},
      %{name: name, commits: 1, own: own},
      &%{&1 | commits: &1.commits + 1}
    )
  end

  defp tally(commit, acc, own_logins) do
    case commit_date(commit) do
      nil ->
        acc

      date ->
        week = week_start(date)
        own = if own?(commit, own_logins), do: 1, else: 0
        Map.update(acc, week, {1, own}, fn {c, o} -> {c + 1, o + own} end)
    end
  end

  defp commit_date(commit) do
    raw =
      get_in(commit, ["commit", "author", "date"]) ||
        get_in(commit, ["commit", "committer", "date"])

    parse_time(raw)
  end

  @doc """
  Zuordnung eines Commits zu den eigenen Accounts.

  Primär über den verknüpften GitHub-Login. Fehlt der - weil die Commit-Mail
  nicht im GitHub-Konto hinterlegt ist, dann steht dort `author: nil` - wird
  über die Mail zugeordnet:

    * GitHubs noreply-Adressen, Format `<id>+<login>@users.noreply.github.com`
      (die Zahl davor ist optional und wurde früher weggelassen)
    * zusätzlich konfigurierte Adressen aus `GITHUB_EMAILS`

  Ohne den zweiten Punkt fallen Commits durch, die mit einer Arbeits- oder
  Hochschulmail entstanden sind - gemessen 31 von 41 in zwei Repositories.
  """
  def own?(commit, own_logins, own_emails \\ nil) do
    logins = MapSet.new(own_logins, &String.downcase/1)

    case get_in(commit, ["author", "login"]) do
      login when is_binary(login) ->
        MapSet.member?(logins, String.downcase(login))

      _ ->
        email = (get_in(commit, ["commit", "author", "email"]) || "") |> String.downcase()
        email != "" and (noreply_of?(email, logins) or configured?(email, own_emails))
    end
  end

  defp noreply_of?(email, logins) do
    case Regex.run(~r/^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/, email) do
      [_, login] -> MapSet.member?(logins, login)
      _ -> false
    end
  end

  defp configured?(email, own_emails) do
    (own_emails || Application.get_env(:timemachine, :own_emails, []))
    |> Enum.any?(&(String.downcase(&1) == email))
  end

  @doc "Sonntag 00:00 UTC der Woche - dieselbe Einteilung wie GitHubs Wochen."
  def week_start(%DateTime{} = dt) do
    date = DateTime.to_date(dt)
    Date.add(date, -Date.day_of_week(date, :sunday) + 1)
  end

  # --- HTTP ---------------------------------------------------------------

  defp request(path, etag) do
    Process.sleep(@delay_ms)

    headers =
      [
        {"accept", "application/vnd.github+json"},
        {"x-github-api-version", "2022-11-28"},
        {"user-agent", "pw23-timemachine"}
      ] ++
        token_header() ++
        if(etag, do: [{"if-none-match", etag}], else: [])

    # Req dekodiert JSON von sich aus zu Maps mit String-Schlüsseln.
    case Req.get(@base <> path, headers: headers, retry: false) do
      {:ok, %{status: 304}} ->
        {:not_modified, nil}

      {:ok, %{status: status, body: body, headers: resp_headers}} when status in 200..299 ->
        {:ok, body, header(resp_headers, "etag")}

      {:ok, %{status: status, body: body, headers: resp_headers}} ->
        {:error, build_error(status, body, resp_headers)}

      {:error, reason} ->
        {:error, %Error{status: 0, message: inspect(reason)}}
    end
  end

  defp build_error(status, body, headers) do
    remaining = header(headers, "x-ratelimit-remaining")
    retry_after = header(headers, "retry-after")

    cond do
      status in [403, 429] and remaining == "0" ->
        reset = header(headers, "x-ratelimit-reset")

        %Error{
          status: status,
          message: "rate limit exhausted, resets at #{reset}",
          retry_after_ms: to_ms(retry_after)
        }

      true ->
        %Error{
          status: status,
          message: inspect(body) |> String.slice(0, 200),
          retry_after_ms: to_ms(retry_after)
        }
    end
  end

  defp to_ms(nil), do: nil

  defp to_ms(seconds) do
    case Integer.parse(seconds) do
      {n, _} when n > 0 -> n * 1000
      _ -> nil
    end
  end

  defp header(headers, name) when is_map(headers) do
    case Map.get(headers, name) do
      [value | _] -> value
      value when is_binary(value) -> value
      _ -> nil
    end
  end

  defp header(headers, name) when is_list(headers) do
    Enum.find_value(headers, fn {k, v} -> if String.downcase(k) == name, do: v end)
  end

  defp token_header do
    case Application.get_env(:timemachine, :github_token) do
      token when is_binary(token) and token != "" -> [{"authorization", "Bearer " <> token}]
      _ -> []
    end
  end

  defp parse_time(nil), do: nil

  defp parse_time(raw) when is_binary(raw) do
    case DateTime.from_iso8601(raw) do
      {:ok, dt, _} -> DateTime.truncate(dt, :second)
      _ -> nil
    end
  end

  # --- ETag-Ablage --------------------------------------------------------

  defp etag_for(url) do
    case Repo.get(HttpCache, url) do
      %HttpCache{etag: etag} -> etag
      nil -> nil
    end
  end

  defp store_etag(url, etag) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    Repo.insert_all(
      HttpCache,
      [%{url: url, etag: etag, fetched_at: now}],
      on_conflict: {:replace, [:etag, :fetched_at]},
      conflict_target: :url
    )

    :ok
  end
end
