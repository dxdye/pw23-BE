import nhttp from "@nhttp/nhttp";
import { load } from "@std/dotenv";
import {
  buildGithubReposUrl,
  createPostgresClient,
  DEFAULT_GITHUB_ACCOUNT,
  getCachedOrFetch,
  initializeCacheTables,
  startCacheCron,
} from "./cacheRoutine.ts";

await load({ export: true });

const dbUrl = Deno.env.get("DATABASE_URL") ?? "postgresql://localhost/pw23";
const port = Number(Deno.env.get("PORT") ?? 8000);
const accounts = (Deno.env.get("GITHUB_ACCOUNTS") ?? DEFAULT_GITHUB_ACCOUNT)
  .split(",")
  .map((account) => account.trim())
  .filter(Boolean);
const accountSet = new Set(accounts);

const client = await createPostgresClient(dbUrl);
await initializeCacheTables(client);

for (const account of accounts) {
  startCacheCron(client, buildGithubReposUrl(account));
}

const app = nhttp();

app.get("/", () => ({ status: "ok" }));

app.get(
  "/github/:account/repos",
  async (ctx: {
    params: { account: string };
    req?: Request;
    request?: Request;
  }) => {
    const account = ctx.params.account;
    if (!accountSet.has(account)) {
      return new Response(JSON.stringify({ error: "Account not configured" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const request = ctx.req ?? ctx.request;
    const historyParam = request
      ? new URL(request.url).searchParams.get("history")
      : null;
    const historyCount = historyParam ? Number(historyParam) : undefined;

    let cached;
    try {
      cached = await getCachedOrFetch(client, buildGithubReposUrl(account));
    } catch (error) {
      console.error("Failed to read GitHub cache", error);
      return new Response(JSON.stringify({ error: "Failed to read cache" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const response: {
      url: string;
      updatedAt: Date;
      data: typeof cached.data;
      history?: { data: typeof cached.data; updatedAt: Date }[];
    } = {
      url: cached.url,
      updatedAt: cached.updatedAt,
      data: cached.data,
    };

    if (Number.isFinite(historyCount) && historyCount! > 0) {
      const sortedHistory = [...(cached.versions ?? [])].sort(
        (a, b) => a.updatedAt.getTime() - b.updatedAt.getTime(),
      );
      return sortedHistory.slice(-historyCount!).map((entry) => ({
        url: cached.url,
        updatedAt: entry.updatedAt,
        data: entry.data,
      }));
    }

    return response;
  },
);

app.listen(port);
console.log(`Server running on http://localhost:${port}`);
