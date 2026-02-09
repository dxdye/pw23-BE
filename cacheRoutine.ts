import { MongoClient } from "mongo";
import { getData } from "./request.ts";
import type { CacheEntry, GitHubApiRepositories } from "./types.ts";

export const DEFAULT_GITHUB_REPOS_URL =
  "https://api.github.com/users/dxdye/repos";

const DEFAULT_DB_NAME = Deno.env.get("MONGO_DB") ?? "pw23";
const DEFAULT_COLLECTION_NAME =
  Deno.env.get("MONGO_COLLECTION") ?? "github_cache";
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
  url: string = DEFAULT_GITHUB_REPOS_URL,
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
  url: string = DEFAULT_GITHUB_REPOS_URL,
) => {
  const cached = await collection.findOne({ url });
  if (cached) return cached;
  return fetchAndCache(collection, url);
};

export const startCacheCron = (
  collection: ReturnType<typeof getCacheCollection>,
  url: string = DEFAULT_GITHUB_REPOS_URL,
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
  const intervalId = setInterval(updateCache, intervalMs);

  return () => clearInterval(intervalId);
};
