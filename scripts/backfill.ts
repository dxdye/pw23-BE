/**
 * Einmaliger Backfill der Commit-Historie (Plan §3).
 *
 * Bewusst ein eigenständiges Skript und nicht Teil des Dienstes: sein Zweck
 * ist herauszufinden, wie die Daten tatsächlich aussehen, bevor Schema,
 * Materialisierer und Slider dagegen gebaut werden.
 *
 *   deno run --allow-net --allow-env --allow-read=. --allow-write=./data \
 *     scripts/backfill.ts
 *
 * Forks bleiben vollständig erhalten, inklusive Upstream-Historie. Pro Woche
 * werden zwei Zahlen erfasst: `commits` (alle) und `commits_own` (Commits, die
 * einem der konfigurierten Accounts zuzuordnen sind). Welche davon die
 * Relevanz-Achse trägt, entscheidet der Materialisierer - der Backfill nimmt
 * die Frage nicht vorweg.
 *
 * Läuft mehrfach ohne Schaden: bereits vollständig erfasste Repos werden aus
 * der vorhandenen Ausgabedatei übernommen und übersprungen.
 */

const OUT = Deno.env.get("BACKFILL_OUT") ?? "./data/backfill.json";
const ACCOUNTS = (Deno.env.get("GITHUB_ACCOUNTS") ?? "dxdye,d2tsb")
  .split(",").map((a) => a.trim()).filter(Boolean);
/** Zusätzliche Commit-Mails, falls lokal mit anderer Adresse committet wurde. */
const EMAILS = (Deno.env.get("GITHUB_EMAILS") ?? "")
  .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
const TOKEN = Deno.env.get("GITHUB_TOKEN");
// Sequenziell mit Pause: parallele Requests lösen die Missbrauchserkennung
// aus, unabhängig vom primären Kontingent (Plan §3.3.2).
const DELAY_MS = Number(Deno.env.get("BACKFILL_DELAY_MS") ?? 150);
const MAX_PAGES = Number(Deno.env.get("BACKFILL_MAX_PAGES") ?? 40);

const OWN_LOGINS = new Set(ACCOUNTS.map((a) => a.toLowerCase()));
const OWN_EMAILS = new Set(EMAILS);

type RepoRow = {
  repo_id: number;
  account: string;
  name: string;
  full_name: string;
  created_at: string;
  pushed_at: string;
  language: string | null;
  size: number;
  fork: boolean;
  archived: boolean;
  private: boolean;
};

type ActivityRow = {
  repo_id: number;
  week_start: string;
  /** Alle Commits auf dem Default-Branch, inklusive Upstream bei Forks. */
  commits: number;
  /** Davon einem der konfigurierten Accounts zuzuordnen. */
  commits_own: number;
};

type Attribution = {
  full_name: string;
  total: number;
  own: number;
  /** Wer im Repo committet hat, absteigend nach Anzahl. */
  authors: { name: string; commits: number; own: boolean }[];
};

type Backfill = {
  generatedAt: string;
  accounts: string[];
  repos: RepoRow[];
  activity: ActivityRow[];
  meta: {
    requests: number;
    rateLimitRemaining: number | null;
    attribution: Attribution[];
    incomplete: { full_name: string; reason: string }[];
  };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sonntag 00:00 UTC der Woche - dieselbe Einteilung wie GitHubs Wochen. */
const weekStart = (iso: string): string => {
  const d = new Date(iso);
  return new Date(Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() - d.getUTCDay(),
  )).toISOString().slice(0, 10);
};

class RateLimitReached extends Error {}

let requests = 0;
let remaining: number | null = null;

const gh = async (
  path: string,
): Promise<{ status: number; body: unknown }> => {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (remaining !== null && remaining <= 1) {
      throw new RateLimitReached(
        `rate limit exhausted (${requests} requests used)`,
      );
    }
    await sleep(DELAY_MS);
    requests++;

    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "pw23-backfill",
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
    });

    const headerRemaining = res.headers.get("x-ratelimit-remaining");
    if (headerRemaining !== null) remaining = Number(headerRemaining);

    // Sekundäres Limit: nicht das Kontingent, sondern die Drosselung.
    const retryAfter = Number(res.headers.get("retry-after"));
    if (res.status === 403 && Number.isFinite(retryAfter) && retryAfter > 0) {
      await res.body?.cancel();
      console.log(`    403, warte ${retryAfter}s (secondary rate limit)`);
      await sleep(retryAfter * 1000);
      continue;
    }
    if (res.status === 403 && remaining === 0) {
      await res.body?.cancel();
      throw new RateLimitReached(`rate limit hit after ${requests} requests`);
    }

    if (res.status === 204) return { status: 204, body: null };
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  throw new Error(`${path}: gave up after repeated throttling`);
};

const listRepos = async (account: string): Promise<RepoRow[]> => {
  const repos: RepoRow[] = [];
  for (let page = 1; page <= 10; page++) {
    const { status, body } = await gh(
      `/users/${account}/repos?per_page=100&page=${page}&sort=created`,
    );
    if (status !== 200 || !Array.isArray(body)) {
      throw new Error(`/users/${account}/repos -> ${status}`);
    }
    for (const r of body as Record<string, unknown>[]) {
      repos.push({
        repo_id: Number(r.id),
        account,
        name: String(r.name),
        full_name: String(r.full_name),
        created_at: String(r.created_at),
        pushed_at: String(r.pushed_at),
        language: (r.language as string | null) ?? null,
        size: Number(r.size ?? 0),
        fork: Boolean(r.fork),
        archived: Boolean(r.archived),
        private: Boolean(r.private),
      });
    }
    if (body.length < 100) break;
  }
  return repos;
};

/** Nur die Felder, die hier gebraucht werden. */
type GhCommit = {
  author?: { login?: string } | null;
  commit?: {
    author?: { date?: string; email?: string; name?: string } | null;
    committer?: { date?: string } | null;
  } | null;
};

/**
 * Ist dieser Commit einem der konfigurierten Accounts zuzuordnen?
 * Primär über den verknüpften GitHub-Login, ersatzweise über die
 * Commit-Mail - Commits ohne verknüpftes Konto haben `author: null`.
 */
const isOwn = (commit: GhCommit): boolean => {
  const login = commit.author?.login;
  if (typeof login === "string") return OWN_LOGINS.has(login.toLowerCase());
  const email = String(commit.commit?.author?.email ?? "").toLowerCase();
  if (!email) return false;
  if (OWN_EMAILS.has(email)) return true;
  // "dxdye@users.noreply.github.com" ordnet sich selbst zu.
  return [...OWN_LOGINS].some((l) => email.startsWith(`${l}@`));
};

const authorLabel = (commit: GhCommit): string =>
  commit.author?.login ??
    commit.commit?.author?.name ??
    commit.commit?.author?.email ??
    "unbekannt";

/**
 * Vollständige Commit-Historie des Default-Branch, ungefiltert. Die Zuordnung
 * passiert lokal: ein Durchlauf liefert damit Gesamt- und Eigenanteil, statt
 * zwei getrennte Abfragen zu brauchen.
 *
 * `stats/commit_activity` wird bewusst nicht verwendet - der Endpunkt kennt
 * keine Autoren-Unterscheidung, reicht nur 52 Wochen zurück und kostete
 * gemessen vier 202-Wiederholungen pro Repo.
 */
const collectCommits = async (fullName: string) => {
  const weeks = new Map<string, { commits: number; own: number }>();
  const authors = new Map<string, { commits: number; own: boolean }>();
  let total = 0;
  let own = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const { status, body } = await gh(
      `/repos/${fullName}/commits?per_page=100&page=${page}`,
    );

    // 409 = leeres Repository, 404 = kein Zugriff.
    if (status === 409 || status === 404) {
      return { weeks, authors, total, own, complete: true };
    }
    if (status !== 200 || !Array.isArray(body)) {
      console.log(`    commits -> ${status}, unvollständig`);
      return { weeks, authors, total, own, complete: false };
    }

    for (const commit of body as GhCommit[]) {
      const date = commit.commit?.author?.date ??
        commit.commit?.committer?.date;
      if (!date) continue;

      const mine = isOwn(commit);
      const week = weeks.get(weekStart(date)) ?? { commits: 0, own: 0 };
      week.commits++;
      if (mine) week.own++;
      weeks.set(weekStart(date), week);

      const label = authorLabel(commit);
      const author = authors.get(label) ?? { commits: 0, own: mine };
      author.commits++;
      authors.set(label, author);

      total++;
      if (mine) own++;
    }

    if (body.length < 100) {
      return { weeks, authors, total, own, complete: true };
    }
  }
  return { weeks, authors, total, own, complete: false };
};

const load = async (): Promise<Backfill | null> => {
  try {
    return JSON.parse(await Deno.readTextFile(OUT)) as Backfill;
  } catch {
    return null;
  }
};

const save = async (data: Backfill) => {
  const dir = OUT.replace(/[^/]+$/, "");
  if (dir) await Deno.mkdir(dir, { recursive: true });
  // Atomar: erst Temp, dann rename - sonst wird irgendwann eine halb
  // geschriebene Datei gelesen (Plan §6.3).
  const tmp = `${OUT}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(data, null, 2));
  await Deno.rename(tmp, OUT);
};

const main = async () => {
  const previous = await load();
  const reusable = new Set(
    previous?.repos
      .filter((r) =>
        !previous.meta.incomplete.some((i) => i.full_name === r.full_name) &&
        // Ältere Läufe kannten commits_own noch nicht.
        previous.activity.some((a) =>
          a.repo_id === r.repo_id && a.commits_own !== undefined
        )
      )
      .map((r) => r.full_name) ?? [],
  );
  if (reusable.size > 0) {
    console.log(
      `${reusable.size} Repos bereits erfasst, werden übersprungen\n`,
    );
  }

  const repos: RepoRow[] = [];
  const activity: ActivityRow[] = [];
  const attribution: Attribution[] = [];
  const incomplete: { full_name: string; reason: string }[] = [];
  let stoppedEarly = false;

  try {
    for (const account of ACCOUNTS) {
      console.log(`\n== ${account} ==`);
      const accountRepos = await listRepos(account);
      console.log(`${accountRepos.length} Repos`);

      for (const repo of accountRepos) {
        repos.push(repo);
        const tag = repo.fork ? " [fork]" : "";

        if (reusable.has(repo.full_name)) {
          const kept = previous!.activity.filter((a) =>
            a.repo_id === repo.repo_id
          );
          activity.push(...kept);
          const keptAttr = previous!.meta.attribution.find((a) =>
            a.full_name === repo.full_name
          );
          if (keptAttr) attribution.push(keptAttr);
          console.log(
            `  ${repo.name}${tag}: übernommen (${kept.length} Wochen)`,
          );
          continue;
        }

        console.log(`  ${repo.name}${tag}`);
        const result = await collectCommits(repo.full_name);

        for (const [week_start, counts] of [...result.weeks].sort()) {
          activity.push({
            repo_id: repo.repo_id,
            week_start,
            commits: counts.commits,
            commits_own: counts.own,
          });
        }

        attribution.push({
          full_name: repo.full_name,
          total: result.total,
          own: result.own,
          authors: [...result.authors]
            .map(([name, a]) => ({ name, commits: a.commits, own: a.own }))
            .sort((a, b) => b.commits - a.commits),
        });

        const earliest = [...result.weeks.keys()].sort()[0] ?? "-";
        const share = result.total
          ? Math.round((result.own / result.total) * 100)
          : 0;
        console.log(
          `    ${result.weeks.size} aktive Wochen, ${result.total} Commits ` +
            `(${result.own} eigene = ${share}%), ab ${earliest}` +
            (result.complete ? "" : "  [unvollständig]"),
        );

        if (!result.complete) {
          incomplete.push({
            full_name: repo.full_name,
            reason: `pagination stopped at ${MAX_PAGES} pages`,
          });
        }
      }
    }
  } catch (error) {
    if (!(error instanceof RateLimitReached)) throw error;
    stoppedEarly = true;
    console.log(`\n!! ${error.message}`);
    console.log(
      "Teilergebnis wird gespeichert - Skript später erneut starten.",
    );
    for (const repo of repos) {
      if (!activity.some((a) => a.repo_id === repo.repo_id)) {
        incomplete.push({ full_name: repo.full_name, reason: "not reached" });
      }
    }
  }

  const result: Backfill = {
    generatedAt: new Date().toISOString(),
    accounts: ACCOUNTS,
    repos,
    activity,
    meta: { requests, rateLimitRemaining: remaining, attribution, incomplete },
  };
  await save(result);

  // Der eigentliche Ertrag des Laufs: wie die Daten aussehen.
  const weeks = [...new Set(activity.map((a) => a.week_start))].sort();
  const commits = activity.reduce((s, a) => s + a.commits, 0);
  const ownCommits = activity.reduce((s, a) => s + a.commits_own, 0);
  const ownWeeks = new Set(
    activity.filter((a) => a.commits_own > 0).map((a) => a.week_start),
  );
  const raw = new TextEncoder().encode(JSON.stringify(result)).length;
  const forks = repos.filter((r) => r.fork).length;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Repos             ${repos.length} (davon ${forks} Forks)`);
  console.log(`Commits gesamt    ${commits}`);
  console.log(`davon eigene      ${ownCommits}`);
  console.log(
    `Aktive Wochen     ${weeks.length} (mit eigenen: ${ownWeeks.size})`,
  );
  console.log(`Zeitraum gesamt   ${weeks[0] ?? "-"} .. ${weeks.at(-1) ?? "-"}`);
  console.log(
    `Zeitraum eigene   ${[...ownWeeks].sort()[0] ?? "-"} .. ${
      [...ownWeeks].sort().at(-1) ?? "-"
    }`,
  );
  console.log(`Aktivitätszeilen  ${activity.length}`);
  console.log(`Requests          ${requests}`);
  console.log(`Rate Limit übrig  ${remaining ?? "?"}`);
  console.log(`Datei             ${OUT} (${(raw / 1024).toFixed(1)} KB)`);

  const foreign = attribution.filter((a) => a.own < a.total);
  if (foreign.length > 0) {
    console.log(`\nRepos mit fremden Commits:`);
    for (const item of foreign) {
      const top = item.authors.slice(0, 4)
        .map((a) => `${a.name}${a.own ? "*" : ""}:${a.commits}`).join(", ");
      console.log(
        `  ${
          item.full_name.padEnd(26)
        } ${item.own}/${item.total} eigen | ${top}`,
      );
    }
    console.log(`  (* = als eigen erkannt)`);
  }
  if (incomplete.length > 0) {
    console.log(`\nUnvollständig (${incomplete.length}):`);
    for (const item of incomplete) {
      console.log(`  ${item.full_name}: ${item.reason}`);
    }
  }
  if (stoppedEarly) Deno.exit(2);
};

await main();
