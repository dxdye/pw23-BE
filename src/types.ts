/** Die Felder, die aus einer GitHub-Repo-Antwort tatsächlich gebraucht werden. */
export type GithubCrawlerInfo = {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  created_at: string;
  pushed_at: string;
  updated_at: string;
  stargazers_count: number;
  forks_count: number;
  size: number;
  archived: boolean;
  fork: boolean;
  topics: string[];
};

export type GitHubApiRepositories = GithubCrawlerInfo[];

export type CacheEntry<T = unknown> = {
  url: string;
  data: T;
  /** ETag der Antwort, aus der `data` stammt; null wenn nicht verwendbar. */
  etag: string | null;
  updatedAt: Date;
};

export type Repository = {
  name: string;
  account: string;
};

/**
 * Commit-Aktivität pro Repository. Key ist `account/name`, kein Objekt:
 * Map-Keys werden per Referenz verglichen, ein Lookup mit einem frisch
 * gebauten `Repository` fände nie einen Eintrag.
 */
export type ActivityRecord = Map<string, number[]>;
