import nhttp from "@nhttp/nhttp";
import { load } from "@std/dotenv";
import {
  buildGithubReposUrl,
  createMongoClient,
  DEFAULT_GITHUB_ACCOUNT,
  getCachedOrFetch,
  getCacheCollection,
  startCacheCron,
} from "./cacheRoutine.ts";

await load({ export: true });

const mongoUrl = Deno.env.get("MONGO_URL") ?? "mongodb://localhost:27017";
const port = Number(Deno.env.get("PORT") ?? 8000);
const accounts = (Deno.env.get("GITHUB_ACCOUNTS") ?? DEFAULT_GITHUB_ACCOUNT)
  .split(",")
  .map((account) => account.trim())
  .filter(Boolean);
const accountSet = new Set(accounts);

const client = await createMongoClient(mongoUrl);
const cacheCollection = getCacheCollection(client);

for (const account of accounts) {
  startCacheCron(cacheCollection, buildGithubReposUrl(account));
}

const app = nhttp();

app.get("/", () => ({ status: "ok" }));

app.get(
  "/github/:account/repos",
  async ({ params }: { params: { account: string } }) => {
    const account = params.account;
    if (!accountSet.has(account)) {
      return new Response(JSON.stringify({ error: "Account not configured" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const cached = await getCachedOrFetch(
      cacheCollection,
      buildGithubReposUrl(account),
    );

    return {
      url: cached.url,
      updatedAt: cached.updatedAt,
      data: cached.data,
    };
  },
);

app.listen(port);
console.log(`Server running on http://localhost:${port}`);
