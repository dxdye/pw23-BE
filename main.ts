import nhttp from "@nhttp/nhttp";
import {
  createMongoClient,
  DEFAULT_GITHUB_REPOS_URL,
  getCachedOrFetch,
  getCacheCollection,
  startCacheCron,
} from "./cacheRoutine.ts";

const mongoUrl = Deno.env.get("MONGO_URL") ?? "mongodb://localhost:27017";
const port = Number(Deno.env.get("PORT") ?? 8000);

const client = await createMongoClient(mongoUrl);
const cacheCollection = getCacheCollection(client);

startCacheCron(cacheCollection);

const app = nhttp();

app.get("/", () => ({ status: "ok" }));

app.get("/github/dxdye/repos", async () => {
  const cached = await getCachedOrFetch(
    cacheCollection,
    DEFAULT_GITHUB_REPOS_URL,
  );

  return {
    url: cached.url,
    updatedAt: cached.updatedAt,
    data: cached.data,
  };
});

app.listen(port);
console.log(`Server running on http://localhost:${port}`);
