import { fetchRepos } from "./request.ts";
import { refreshLanguages } from "./languages.ts";
import type { CacheStore, RepoCacheEntry } from "./store.ts";

export const buildGithubReposUrl = (account: string) =>
  `https://api.github.com/users/${account}/repos`;

export type CachedResult = RepoCacheEntry & {
  /** true, wenn der Eintrag älter als die TTL ist und der Refresh scheiterte. */
  stale: boolean;
};

// Ein laufender Fetch pro URL. Ohne das lösen N gleichzeitige Anfragen auf
// einen kalten Cache N GitHub-Requests aus - genau in dem Moment, in dem das
// Rate Limit ohnehin knapp ist.
const inFlight = new Map<string, Promise<RepoCacheEntry>>();

/**
 * Holt den aktuellen Stand von GitHub und schreibt ihn in den Store.
 * Wirft bei jedem Fehler - der Store wird dann *nicht* angefasst, damit eine
 * Fehlerantwort keine funktionierenden Daten überschreibt.
 */
export const fetchAndCache = (
  store: CacheStore,
  url: string,
  timeoutMs?: number,
): Promise<RepoCacheEntry> => {
  const running = inFlight.get(url);
  if (running) return running;

  const task = (async () => {
    const previous = store.get(url);
    const result = await fetchRepos(url, previous?.etag ?? null, timeoutMs);
    const updatedAt = new Date();

    if (result.status === "not-modified") {
      if (previous) {
        store.touch(url, updatedAt, previous.etag);
        return { ...previous, updatedAt };
      }
      // 304 ohne Eintrag im Store kann nur passieren, wenn die Datenbank unter
      // uns geleert wurde. Dann ohne ETag neu holen.
      const retried = await fetchRepos(url, null, timeoutMs);
      if (retried.status === "not-modified") {
        throw new Error(`Unexpected 304 without a cached entry for ${url}`);
      }
      return store.put({
        url,
        data: retried.data,
        etag: retried.etag,
        updatedAt,
      });
    }

    return store.put({ url, data: result.data, etag: result.etag, updatedAt });
  })().finally(() => inFlight.delete(url));

  inFlight.set(url, task);
  return task;
};

/**
 * Liefert den gecachten Stand. Ist er jünger als die TTL, wird er direkt
 * zurückgegeben. Sonst wird aufgefrischt - und wenn das scheitert, kommen die
 * alten Daten mit `stale: true` zurück statt eines Fehlers. Genau dafür
 * existiert der Cache: die Website soll ein GitHub-Rate-Limit überleben.
 */
export const getCachedOrFetch = async (
  store: CacheStore,
  url: string,
  ttlMs: number,
  timeoutMs?: number,
): Promise<CachedResult> => {
  const cached = store.get(url);
  if (cached && Date.now() - cached.updatedAt.getTime() < ttlMs) {
    return { ...cached, stale: false };
  }

  try {
    return { ...(await fetchAndCache(store, url, timeoutMs)), stale: false };
  } catch (error) {
    if (!cached) throw error;
    console.warn(
      `Serving stale cache for ${url} (from ${cached.updatedAt.toISOString()}):`,
      error instanceof Error ? error.message : error,
    );
    return { ...cached, stale: true };
  }
};

/**
 * Periodischer Refresh. Der nächste Lauf wird erst nach dem Ende des
 * vorherigen geplant - anders als bei `setInterval` können sich Läufe so nicht
 * überholen, wenn GitHub einmal langsam antwortet.
 */
export const startCacheRefresh = (
  store: CacheStore,
  url: string,
  intervalMs: number,
  timeoutMs?: number,
) => {
  // ReturnType statt number: sobald irgendwo node:-Module importiert werden
  // (hier store.ts mit node:sqlite), zieht Deno Nodes globale Typen herein,
  // und dort liefert setTimeout ein Timeout-Objekt statt einer Zahl.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const tick = async () => {
    try {
      await fetchAndCache(store, url, timeoutMs);
      // Sprachen nachgelagert und gedrosselt - siehe languages.ts. Schlaegt
      // das fehl, bleibt die Repo-Liste trotzdem aktuell.
      const { fetched } = await refreshLanguages(store, url, { timeoutMs });
      if (fetched > 0) console.log(`Fetched languages for ${fetched} repos`);
    } catch (error) {
      console.error(
        `Failed to refresh ${url}:`,
        error instanceof Error ? error.message : error,
      );
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  void tick();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
};
