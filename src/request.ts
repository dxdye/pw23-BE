import type { GitHubApiRepositories, GithubCrawlerInfo } from "./types.ts";

const DEFAULT_HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "pw23-backend-cache",
};

const PER_PAGE = 100;
const MAX_PAGES = 10;

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

// Token wird bei jedem Aufruf frisch gelesen, nicht beim Import: so hängt das
// Modul nicht an der Reihenfolge, in der die Umgebung geladen wurde.
const buildHeaders = (etag: string | null): Record<string, string> => {
  const headers = { ...DEFAULT_HEADERS };
  const token = Deno.env.get("GITHUB_TOKEN");
  if (token) headers.Authorization = `Bearer ${token}`;
  if (etag) headers["If-None-Match"] = etag;
  return headers;
};

/**
 * Reduziert eine Repo-Antwort auf die benötigten Felder. GitHub liefert 81
 * Felder pro Repo, davon 43 URL-Templates, die schematisch aus Owner und Name
 * ableitbar sind - rund 5 KB pro Repo, von denen ein Bruchteil gebraucht wird.
 */
const toSummary = (repo: Record<string, unknown>): GithubCrawlerInfo => ({
  id: Number(repo.id),
  name: String(repo.name ?? ""),
  full_name: String(repo.full_name ?? ""),
  html_url: String(repo.html_url ?? ""),
  description: (repo.description as string | null) ?? null,
  language: (repo.language as string | null) ?? null,
  // Wird nachgelagert ergaenzt - siehe languages.ts. null heisst "unbekannt".
  languages: null,
  created_at: String(repo.created_at ?? ""),
  pushed_at: String(repo.pushed_at ?? ""),
  updated_at: String(repo.updated_at ?? ""),
  stargazers_count: Number(repo.stargazers_count ?? 0),
  forks_count: Number(repo.forks_count ?? 0),
  size: Number(repo.size ?? 0),
  archived: Boolean(repo.archived),
  fork: Boolean(repo.fork),
  topics: Array.isArray(repo.topics) ? (repo.topics as string[]) : [],
});

const toError = async (res: Response): Promise<GitHubError> => {
  const body = await res.text().catch(() => "");
  const remaining = res.headers.get("x-ratelimit-remaining");
  const retryAfter = Number(res.headers.get("retry-after"));

  if ((res.status === 403 || res.status === 429) && remaining === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.max(0, reset - Date.now());
    return new GitHubError(
      `GitHub rate limit exhausted, resets in ${Math.round(waitMs / 1000)}s`,
      res.status,
      waitMs,
    );
  }

  return new GitHubError(
    `GitHub responded ${res.status}: ${body.slice(0, 200)}`,
    res.status,
    Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : undefined,
  );
};

const parseRepos = async (res: Response): Promise<GithubCrawlerInfo[]> => {
  const text = await res.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new GitHubError(
      `GitHub returned non-JSON body: ${text.slice(0, 200)}`,
      res.status,
    );
  }
  // Fehlerantworten von GitHub sind Objekte, keine Arrays. Ohne diese Prüfung
  // landet `{"message": "..."}` als vermeintliche Repo-Liste im Cache.
  if (!Array.isArray(payload)) {
    throw new GitHubError(
      `GitHub returned ${typeof payload} instead of a repository array`,
      res.status,
    );
  }
  return payload.map((repo) => toSummary(repo as Record<string, unknown>));
};

export type FetchResult =
  | { status: "ok"; data: GitHubApiRepositories; etag: string | null }
  | { status: "not-modified" };

/**
 * Holt alle Repositories eines Accounts, paginiert und auf die benötigten
 * Felder reduziert. Mit `etag` wird ein Conditional Request gestellt: eine
 * 304-Antwort zählt nur dann nicht gegen das Rate Limit, wenn der Request
 * authentifiziert war - ohne GITHUB_TOKEN kostet auch ein 304 einen Request
 * (gemessen). Sie spart also in jedem Fall Übertragung, das Kontingent aber
 * erst mit Token.
 */
export const fetchRepos = async (
  url: string,
  etag: string | null = null,
  timeoutMs = 15_000,
): Promise<FetchResult> => {
  const repos: GithubCrawlerInfo[] = [];
  let firstEtag: string | null = null;
  let page = 1;

  while (page <= MAX_PAGES) {
    const pageUrl = `${url}?per_page=${PER_PAGE}&page=${page}`;
    const res = await fetch(pageUrl, {
      method: "GET",
      headers: buildHeaders(page === 1 ? etag : null),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (page === 1 && res.status === 304) {
      await res.body?.cancel();
      return { status: "not-modified" };
    }
    if (!res.ok) throw await toError(res);

    if (page === 1) firstEtag = res.headers.get("etag");
    const batch = await parseRepos(res);
    repos.push(...batch);

    if (batch.length < PER_PAGE) {
      // Der ETag der ersten Seite deckt nur diese Seite ab. Nur wenn alles auf
      // eine Seite passt, ist ein 304 darauf für den Gesamtstand aussagekräftig.
      return { status: "ok", data: repos, etag: page === 1 ? firstEtag : null };
    }
    page++;
  }

  console.warn(
    `Stopped paginating ${url} after ${MAX_PAGES} pages (${repos.length} repos)`,
  );
  return { status: "ok", data: repos, etag: null };
};

export type LanguagesResult =
  | { status: "ok"; data: Record<string, number>; etag: string | null }
  | { status: "not-modified" };

/**
 * Sprachverteilung eines einzelnen Repositories.
 *
 * `/users/:account/repos` liefert nur `language`, also die groesste Sprache.
 * Die Aufschluesselung gibt es ausschliesslich unter
 * `/repos/:owner/:name/languages` - ein zusaetzlicher Request je Repository.
 * Deshalb wird dieser Aufruf gedrosselt und nur bei Bedarf gemacht.
 */
export const fetchLanguages = async (
  url: string,
  etag: string | null = null,
  timeoutMs = 15_000,
): Promise<LanguagesResult> => {
  const res = await fetch(url, {
    method: "GET",
    headers: buildHeaders(etag),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.status === 304) {
    await res.body?.cancel();
    return { status: "not-modified" };
  }
  if (!res.ok) throw await toError(res);

  const payload = await res.json().catch(() => null);
  // Fehlerantworten sind ebenfalls Objekte - hier hilft nur die Pruefung, ob
  // die Werte tatsaechlich Zahlen sind.
  if (
    payload === null || typeof payload !== "object" || Array.isArray(payload)
  ) {
    throw new GitHubError(
      "GitHub returned a non-object language map",
      res.status,
    );
  }

  const data: Record<string, number> = {};
  for (
    const [name, bytes] of Object.entries(payload as Record<string, unknown>)
  ) {
    if (typeof bytes === "number" && Number.isFinite(bytes)) data[name] = bytes;
  }

  return { status: "ok", data, etag: res.headers.get("etag") };
};
