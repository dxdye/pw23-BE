import { DatabaseSync } from "node:sqlite";
import type { CacheEntry, GitHubApiRepositories } from "./types.ts";

export type RepoCacheEntry = CacheEntry<GitHubApiRepositories>;

type Row = {
  url: string;
  data: string;
  etag: string | null;
  updated_at: string;
};

/**
 * Cache-Ablage auf SQLite (`node:sqlite`, in Deno eingebaut - kein Treiber,
 * kein Serverprozess, kein zweiter Container). Der Cache besteht aus einer
 * Zeile pro Account; ein Datenbankserver dafür wäre auf einem 1-GB-Host
 * verschenkter Arbeitsspeicher.
 */
export const createCacheStore = (path: string) => {
  if (path !== ":memory:") {
    const dir = path.replace(/[^/]+$/, "");
    if (dir) Deno.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_entry (
      url        TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      etag       TEXT,
      updated_at TEXT NOT NULL
    )
  `);

  const selectStmt = db.prepare("SELECT * FROM cache_entry WHERE url = ?");
  const upsertStmt = db.prepare(`
    INSERT INTO cache_entry (url, data, etag, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      data = excluded.data,
      etag = excluded.etag,
      updated_at = excluded.updated_at
  `);
  const touchStmt = db.prepare(
    "UPDATE cache_entry SET updated_at = ?, etag = ? WHERE url = ?",
  );

  return {
    /**
     * Generisch mit Vorgabe auf die Repo-Liste: bestehende Aufrufer bleiben
     * unveraendert, die Sprachdaten koennen dieselbe Tabelle mitbenutzen. Der
     * Schluessel ist ohnehin die URL, und die ist je Datenart verschieden.
     */
    get<T = GitHubApiRepositories>(url: string): CacheEntry<T> | null {
      const row = selectStmt.get(url) as Row | undefined;
      if (!row) return null;
      return {
        url: row.url,
        data: JSON.parse(row.data) as T,
        etag: row.etag,
        updatedAt: new Date(row.updated_at),
      };
    },

    put<T = GitHubApiRepositories>(entry: CacheEntry<T>): CacheEntry<T> {
      upsertStmt.run(
        entry.url,
        JSON.stringify(entry.data),
        entry.etag,
        entry.updatedAt.toISOString(),
      );
      return entry;
    },

    /** Nach einem 304: Inhalt bleibt, nur die Frische wird bestätigt. */
    touch(url: string, updatedAt: Date, etag: string | null): void {
      touchStmt.run(updatedAt.toISOString(), etag, url);
    },

    close(): void {
      db.close();
    },
  };
};

export type CacheStore = ReturnType<typeof createCacheStore>;
