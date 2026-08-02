import nhttp from "@nhttp/nhttp";
import type { CacheStore } from "./store.ts";
import { buildGithubReposUrl, getCachedOrFetch } from "./cacheRoutine.ts";

export type AppOptions = {
  store: CacheStore;
  accounts: readonly string[];
  cacheTtlMs: number;
  refreshIntervalMs: number;
  requestTimeoutMs?: number;
  corsOrigins?: readonly string[];
};

/**
 * Baut die HTTP-App. Bewusst getrennt vom Serverstart in main.ts, damit die
 * Routen ohne Port, Signale und Umgebungsvariablen getestet werden können.
 */
export const createApp = (options: AppOptions) => {
  const {
    store,
    accounts,
    cacheTtlMs,
    refreshIntervalMs,
    requestTimeoutMs,
    corsOrigins = ["*"],
  } = options;
  const accountSet = new Set(accounts);
  const allowAll = corsOrigins.includes("*");

  const corsHeaders = (origin: string | null): Record<string, string> => {
    const allowed = allowAll
      ? "*"
      : origin && corsOrigins.includes(origin)
      ? origin
      : "";
    if (!allowed) return {};
    return {
      "Access-Control-Allow-Origin": allowed,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
      ...(allowAll ? {} : { Vary: "Origin" }),
    };
  };

  const app = nhttp();

  // Rohe `Response`-Rückgaben umgehen die Middleware-Header von nhttp, deshalb
  // bekommt die Preflight-Antwort ihre CORS-Header direkt mitgegeben.
  // deno-lint-ignore no-explicit-any
  app.use((rev: any, next: any) => {
    const headers = corsHeaders(rev.request.headers.get("origin"));
    if (rev.request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }
    rev.response.header(headers);
    return next();
  });

  // Der Standard-Handler von nhttp liefert `stack` an den Client aus. Interne
  // Pfade und Fehlertexte gehören nicht in eine öffentliche Antwort: geloggt
  // wird vollständig, ausgeliefert nur der Statuscode.
  // deno-lint-ignore no-explicit-any
  app.onError((error: any, rev: any) => {
    const status = typeof error?.status === "number" ? error.status : 500;
    if (status >= 500) console.error("Unhandled request error:", error);
    return new Response(
      JSON.stringify({
        error: status === 404 ? "Not found" : "Internal server error",
      }),
      {
        status,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders(rev?.request?.headers?.get("origin") ?? null),
        },
      },
    );
  });

  // Unbekannte Routen laufen nicht über onError, sondern über einen eigenen
  // Handler - dessen Standardantwort enthält Route und interne Fehlerklasse.
  // deno-lint-ignore no-explicit-any
  app.on404((rev: any) =>
    new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders(rev?.request?.headers?.get("origin") ?? null),
      },
    })
  );

  app.get("/", () => ({
    status: "ok",
    accounts: accounts.map((account) => {
      const entry = store.get(buildGithubReposUrl(account));
      return {
        account,
        cached: entry !== null,
        updatedAt: entry?.updatedAt.toISOString() ?? null,
        repos: entry?.data.length ?? 0,
      };
    }),
  }));

  app.get(
    "/github/:account/repos",
    // deno-lint-ignore no-explicit-any
    async (rev: any) => {
      const account = rev.params.account;
      // Allowlist: verhindert, dass ein beliebiger Pfadwert in eine ausgehende
      // URL wandert, und begrenzt den Cache auf konfigurierte Accounts.
      if (!accountSet.has(account)) {
        rev.response.status(404);
        return { error: "Account not configured" };
      }

      const cached = await getCachedOrFetch(
        store,
        buildGithubReposUrl(account),
        cacheTtlMs,
        requestTimeoutMs,
      );

      rev.response.header({
        "Cache-Control": `public, max-age=${
          Math.floor(refreshIntervalMs / 1000)
        }`,
      });

      return {
        account,
        url: cached.url,
        updatedAt: cached.updatedAt.toISOString(),
        stale: cached.stale,
        count: cached.data.length,
        data: cached.data,
      };
    },
  );

  return app;
};
