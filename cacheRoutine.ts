import { Client } from "postgres";
import { getData } from "./request.ts";
import type { GitHubApiRepositories, CacheEntry } from "./types.ts";

export const DEFAULT_GITHUB_ACCOUNT = "dxdye";
export const buildGithubReposUrl = (account: string) =>
  `https://api.github.com/users/${account}/repos`;

const DEFAULT_CACHE_TABLE = Deno.env.get("CACHE_TABLE") ?? "cache_entries";
const DEFAULT_VERSIONS_TABLE =
  Deno.env.get("VERSIONS_TABLE") ?? "cache_versions";
const DEFAULT_CRON_SCHEDULE =
  Deno.env.get("CACHE_REFRESH_CRON") ?? "*/5 * * * *";
const DEFAULT_CRON_INTERVAL_MS = Number(
  Deno.env.get("CACHE_REFRESH_INTERVAL_MS") ?? 5 * 60 * 1000,
);

// Helper to safely extract arrays from query results
// deno-lint-ignore no-explicit-any
function extractQueryArray(result: any): unknown[][] {
  // If result is already an array, return it
  if (Array.isArray(result)) {
    return result;
  }
  // If result has a rows property (QueryResult format), return rows
  if (result && Array.isArray(result.rows)) {
    return result.rows;
  }
  // Otherwise return empty array
  return [];
}

export const createPostgresClient = async (dbUrl: string) => {
  const client = new Client(dbUrl);
  await client.connect();
  return client;
};

export const initializeCacheTables = async (
  client: Client,
  _cacheTable: string = DEFAULT_CACHE_TABLE,
  _versionsTable: string = DEFAULT_VERSIONS_TABLE,
) => {
  try {
    // Read SQL schema from file
    const schemaPath = new URL("./schema.sql", import.meta.url);
    console.info("Reading schema from:", schemaPath.pathname);

    const schemaSql = await Deno.readTextFile(schemaPath);
    console.info("Schema file read successfully, length:", schemaSql.length);

    // Parse SQL statements: split by semicolon and filter out comments and empty lines
    const statements = schemaSql
      .split(";")
      .map((stmt) => {
        // Remove line comments (--) and trim
        return stmt
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n")
          .trim();
      })
      .filter((stmt) => stmt.length > 0);

    console.info("Executing", statements.length, "SQL statements");

    for (const statement of statements) {
      console.info("Executing:", statement.substring(0, 80) + "...");
      await client.queryArray(statement);
    }

    console.info("Cache tables initialized successfully.");
  } catch (error) {
    console.error("Failed to initialize cache tables:", error);
    throw error;
  }
};

export const fetchAndCache = async (
  client: Client,
  url: string = buildGithubReposUrl(DEFAULT_GITHUB_ACCOUNT),
  cacheTable: string = DEFAULT_CACHE_TABLE,
  versionsTable: string = DEFAULT_VERSIONS_TABLE,
): Promise<CacheEntry<GitHubApiRepositories>> => {
  const existingResult = await client.queryArray(
    `SELECT data, updated_at FROM ${cacheTable} WHERE url = $1`,
    [url],
  );
  const existing = extractQueryArray(existingResult);

  const data = await getData<GitHubApiRepositories>(url);
  const updatedAt = new Date();

  await client.queryArray(
    `INSERT INTO ${cacheTable} (url, data, updated_at)
      VALUES ($1, $2, $3)
     ON CONFLICT (url) DO UPDATE SET data = $2, updated_at = $3`,
    [url, JSON.stringify(data), updatedAt.toISOString()],
  );

  await client.queryArray(
    `INSERT INTO ${versionsTable} (url, data, updated_at)
      VALUES ($1, $2, $3)`,
    [url, JSON.stringify(data), updatedAt.toISOString()],
  );

  if (existing.length === 0) {
    console.info("Cache miss. Stored initial GitHub data.", { url });
  } else {
    const versionCountResult = await client.queryArray(
      `SELECT COUNT(*) as count FROM ${versionsTable} WHERE url = $1`,
      [url],
    );
    const versionCount = extractQueryArray(versionCountResult);
    console.info("Cache updated. Added history entry.", {
      url,
      historyCount: Number(versionCount[0][0]) + 1,
    });
  }

  const versionsResult = await client.queryArray(
    `SELECT data, updated_at FROM ${versionsTable}
      WHERE url = $1 ORDER BY updated_at ASC`,
    [url],
  );
  const versions = extractQueryArray(versionsResult);

  return {
    url,
    data,
    updatedAt,
    versions: versions.map((row: unknown[]) => ({
      data: typeof row[0] === "string" ? JSON.parse(row[0]) : row[0],
      updatedAt: new Date(row[1] as string),
    })),
  };
};

export const getCachedOrFetch = async (
  client: Client,
  url: string = buildGithubReposUrl(DEFAULT_GITHUB_ACCOUNT),
  cacheTable: string = DEFAULT_CACHE_TABLE,
  versionsTable: string = DEFAULT_VERSIONS_TABLE,
): Promise<CacheEntry<GitHubApiRepositories>> => {
  const cachedResult = await client.queryArray(
    `SELECT data, updated_at FROM ${cacheTable} WHERE url = $1`,
    [url],
  );
  const cached = extractQueryArray(cachedResult);

  if (cached.length > 0) {
    const versionsResult = await client.queryArray(
      `SELECT data, updated_at FROM ${versionsTable}
        WHERE url = $1 ORDER BY updated_at ASC`,
      [url],
    );
    const versions = extractQueryArray(versionsResult);

    return {
      url,
      data:
        typeof cached[0][0] === "string"
          ? JSON.parse(cached[0][0])
          : cached[0][0],
      updatedAt: new Date(cached[0][1] as string),
      versions: versions.map((row: unknown[]) => ({
        data: typeof row[0] === "string" ? JSON.parse(row[0]) : row[0],
        updatedAt: new Date(row[1] as string),
      })),
    };
  }

  console.info("Cache miss. Fetching GitHub data.", { url });
  return fetchAndCache(client, url, cacheTable, versionsTable);
};

export const startCacheCron = (
  client: Client,
  url: string = buildGithubReposUrl(DEFAULT_GITHUB_ACCOUNT),
  cronSchedule: string = DEFAULT_CRON_SCHEDULE,
  intervalMs: number = DEFAULT_CRON_INTERVAL_MS,
) => {
  const updateCache = async () => {
    try {
      console.info(`[CRON] Refreshing cache for: ${url}`);
      await fetchAndCache(client, url);
    } catch (error) {
      console.error("Failed to refresh GitHub cache", error);
    }
  };

  // Initial update immediately
  void updateCache();

  // Use Deno.cron if available
  if (
    "cron" in Deno &&
    typeof (Deno as unknown as { cron?: unknown }).cron === "function"
  ) {
    // Sanitize cron name: only alphanumeric, whitespace, hyphens, underscores
    const cronName = `refresh-${url.replace(/[^a-z0-9_\s-]/gi, "-")}`.substring(
      0,
      50,
    );
    console.info(`[CRON] Starting cron schedule: "${cronSchedule}" for ${url}`);
    (
      Deno as unknown as {
        cron: (name: string, schedule: string, fn: () => Promise<void>) => void;
      }
    ).cron(cronName, cronSchedule, updateCache);
    return () => undefined;
  }

  // Fallback to setInterval
  console.info(`[CRON] Using interval fallback: ${intervalMs}ms for ${url}`);
  const intervalId = setInterval(updateCache, intervalMs);
  return () => clearInterval(intervalId);
};
