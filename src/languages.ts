import { fetchLanguages } from "./request.ts";
import type { CacheStore } from "./store.ts";
import type { GithubCrawlerInfo, LanguageEntry } from "./types.ts";

export const buildLanguagesUrl = (fullName: string) =>
  `https://api.github.com/repos/${fullName}/languages`;

/**
 * Wie viele Sprach-Abfragen ein Refresh-Lauf hoechstens auslöst.
 *
 * Der Dienst läuft ohne GITHUB_TOKEN, also mit 60 Anfragen pro Stunde. Ein
 * normaler Lauf kostet zwei (eine je Account). Beim ersten Start sind alle
 * Repositories unbekannt - würde man dann alle auf einmal abfragen, wäre das
 * Kontingent sofort aufgebraucht und die eigentliche Repo-Liste bliebe leer.
 *
 * Mit dieser Grenze verteilt sich ein Kaltstart über mehrere Läufe. Bei 15
 * Repositories und einem Lauf alle 15 Minuten ist die Aufholphase nach etwa
 * einer Stunde beendet; danach kostet es fast nichts mehr, weil nur noch
 * bespielte Projekte neu abgefragt werden.
 */
export const DEFAULT_BUDGET = 4;

/**
 * Welche Repositories brauchen einen neuen Sprach-Abruf?
 *
 * Kriterium ist `pushed_at`: Solange nichts gepusht wurde, kann sich die
 * Sprachverteilung nicht geändert haben. Damit kostet der Regelbetrieb nichts
 * und nur tatsächliche Arbeit am Projekt löst einen Abruf aus.
 *
 * Reine Funktion, damit die Auswahl ohne Netz und ohne Datenbank prüfbar ist.
 */
export const selectStale = (
  repos: GithubCrawlerInfo[],
  cached: (fullName: string) => LanguageEntry | null,
  budget: number = DEFAULT_BUDGET,
): GithubCrawlerInfo[] => {
  const stale = repos.filter((repo) => {
    const entry = cached(repo.full_name);
    return entry === null || entry.pushedAt !== repo.pushed_at;
  });

  // Zuletzt bespielte zuerst: Wenn das Budget nicht reicht, sind die aktuellen
  // Projekte die, die ein Besucher am ehesten zu sehen bekommt.
  return stale
    .sort((a, b) =>
      new Date(b.pushed_at).getTime() - new Date(a.pushed_at).getTime()
    )
    .slice(0, budget);
};

/** Hängt bekannte Sprachdaten an die Repo-Objekte. Verändert nichts im Netz. */
export const applyCached = (
  repos: GithubCrawlerInfo[],
  cached: (fullName: string) => LanguageEntry | null,
): GithubCrawlerInfo[] =>
  repos.map((repo) => {
    const entry = cached(repo.full_name);
    return entry === null ? repo : { ...repo, languages: entry.languages };
  });

/**
 * Ergänzt die Sprachverteilung im Hintergrund und schreibt die angereicherte
 * Repo-Liste zurück in den Store.
 *
 * Bewusst NICHT im Request-Pfad: Ein Besucher darf keinen Schwall von
 * GitHub-Anfragen auslösen können. Aufgerufen wird das aus dem Refresh-Lauf,
 * nachdem die Repo-Liste steht.
 */
export const refreshLanguages = async (
  store: CacheStore,
  reposUrl: string,
  options: { budget?: number; timeoutMs?: number } = {},
): Promise<{ fetched: number; skipped: number }> => {
  const entry = store.get(reposUrl);
  if (!entry) return { fetched: 0, skipped: 0 };

  const readCache = (fullName: string): LanguageEntry | null =>
    store.get<LanguageEntry>(buildLanguagesUrl(fullName))?.data ?? null;

  const pending = selectStale(
    entry.data,
    readCache,
    options.budget ?? DEFAULT_BUDGET,
  );
  let fetched = 0;

  for (const repo of pending) {
    const url = buildLanguagesUrl(repo.full_name);
    try {
      const previous = store.get<LanguageEntry>(url);
      const result = await fetchLanguages(
        url,
        previous?.etag ?? null,
        options.timeoutMs,
      );

      // Bei 304 hat sich nichts geändert - dann nur den pushed_at-Stand
      // nachziehen, damit dasselbe Repository nicht in jedem Lauf erneut
      // abgefragt wird.
      const languages = result.status === "not-modified"
        ? previous?.data.languages ?? {}
        : result.data;

      store.put<LanguageEntry>({
        url,
        data: { pushedAt: repo.pushed_at, languages },
        etag: result.status === "not-modified"
          ? previous?.etag ?? null
          : result.etag,
        updatedAt: new Date(),
      });
      fetched++;
    } catch (error) {
      // Ein einzelnes Repository darf den Lauf nicht abbrechen - beim
      // nächsten Mal ist es wieder dran.
      console.warn(
        `Failed to fetch languages for ${repo.full_name}:`,
        error instanceof Error ? error.message : error,
      );
      break; // Bei Rate-Limit-Fehlern hätte auch der nächste keine Chance.
    }
  }

  // Angereicherte Liste zurückschreiben, damit der Lesepfad unverändert
  // bleibt: die Route liefert weiterhin einfach, was im Store steht.
  //
  // Nur wenn tatsächlich etwas geholt wurde. Sonst schriebe jeder Lauf alle
  // vier Minuten denselben Inhalt neu - Arbeit ohne Wirkung, und auf einem
  // Ein-Kern-Host mit SQLite ist das unnötig.
  if (fetched > 0) {
    store.put({
      ...entry,
      data: applyCached(entry.data, readCache),
    });
  }

  return { fetched, skipped: entry.data.length - fetched };
};
