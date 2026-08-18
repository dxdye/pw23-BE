/** Die Felder, die aus einer GitHub-Repo-Antwort tatsächlich gebraucht werden. */
export type GithubCrawlerInfo = {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  /**
   * Vollstaendige Sprachverteilung in Bytes, z.B. { TypeScript: 42297, Nix: 1037 }.
   *
   * `language` allein zeigt nur die groesste - ein Projekt aus TypeScript,
   * SCSS und Nix sieht damit aus wie ein reines TypeScript-Projekt.
   *
   * null bedeutet "noch nicht geholt", nicht "keine Sprachen": Die Angabe
   * kostet einen eigenen Request pro Repository und wird deshalb nachgelagert
   * und gedrosselt ergaenzt (siehe languages.ts).
   */
  languages: Record<string, number> | null;
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

/** Im Cache abgelegte Sprachdaten eines Repositories. */
export type LanguageEntry = {
  /** Stand, zu dem geholt wurde - Trigger fuer das erneute Holen. */
  pushedAt: string;
  languages: Record<string, number>;
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
