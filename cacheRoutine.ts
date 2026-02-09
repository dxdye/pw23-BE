import { MongoClient } from "mongo";
import { getData } from "./request.ts";
import type { CacheEntry, GitHubApiRepositories } from "./types.ts";

export const DEFAULT_GITHUB_ACCOUNT = "dxdye";
export const buildGithubReposUrl = (account: string) =>
  `https://api.github.com/users/${account}/repos`;

const DEFAULT_DB_NAME = Deno.env.get("MONGO_DB") ?? "pw23";
const DEFAULT_COLLECTION_NAME =
  Deno.env.get("MONGO_COLLECTION") ?? "github_cache";
const DEFAULT_CRON_SCHEDULE =
  Deno.env.get("CACHE_REFRESH_CRON") ?? "*/5 * * * *";
const DEFAULT_CRON_INTERVAL_MS = Number(
  Deno.env.get("CACHE_REFRESH_INTERVAL_MS") ?? 5 * 60 * 1000,
);

export const createMongoClient = async (mongoUrl: string) => {
  const client = new MongoClient();
  await client.connect(mongoUrl);
  return client;
};

export const getCacheCollection = (
  client: MongoClient,
  dbName: string = DEFAULT_DB_NAME,
  collectionName: string = DEFAULT_COLLECTION_NAME,
) =>
  client
    .database(dbName)
    .collection<CacheEntry<GitHubApiRepositories>>(collectionName);

export const fetchAndCache = async (
  collection: ReturnType<typeof getCacheCollection>,
  url: string = buildGithubReposUrl(DEFAULT_GITHUB_ACCOUNT),
) => {
  const data = await getData<GitHubApiRepositories>(url);
  const updatedAt = new Date();
  const cacheEntry: CacheEntry<GitHubApiRepositories> = {
    url,
    data,
    updatedAt,
  };

  await collection.updateOne({ url }, { $set: cacheEntry }, { upsert: true });

  return cacheEntry;
};

export const getCachedOrFetch = async (
  collection: ReturnType<typeof getCacheCollection>,
  url: string = buildGithubReposUrl(DEFAULT_GITHUB_ACCOUNT),
) => {
  const cached = await collection.findOne({ url });
  if (cached) return cached;
  return fetchAndCache(collection, url);
};

export const startCacheCron = (
  collection: ReturnType<typeof getCacheCollection>,
  url: string = buildGithubReposUrl(DEFAULT_GITHUB_ACCOUNT),
  cronSchedule: string = DEFAULT_CRON_SCHEDULE,
  intervalMs: number = DEFAULT_CRON_INTERVAL_MS,
) => {
  const updateCache = async () => {
    try {
      await fetchAndCache(collection, url);
    } catch (error) {
      console.error("Failed to refresh GitHub cache", error);
    }
  };

  void updateCache();
  if ("cron" in Deno) {
    Deno.cron(`refresh ${url}`, cronSchedule, updateCache);
    return () => undefined;
  }

  const intervalId = setInterval(updateCache, intervalMs);
  return () => clearInterval(intervalId);
};
