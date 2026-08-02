import { assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createCacheStore } from "../src/store.ts";
import { buildGithubReposUrl } from "../src/cacheRoutine.ts";
import { rawRepo, summary, withFetch } from "./helpers.ts";

const ACCOUNTS = ["dxdye", "d2tsb"] as const;

/**
 * Baut App und Store, füllt den Cache vor und ruft `app.handle()` direkt auf -
 * kein Port, kein laufender Server, kein Netzwerk.
 */
const withApp = async (
  fn: (
    request: (path: string, init?: RequestInit) => Promise<Response>,
    store: ReturnType<typeof createCacheStore>,
  ) => Promise<void>,
  options: { corsOrigins?: string[]; prefill?: boolean } = {},
) => {
  const { corsOrigins = ["*"], prefill = true } = options;
  const store = createCacheStore(":memory:");
  try {
    if (prefill) {
      for (const account of ACCOUNTS) {
        store.put({
          url: buildGithubReposUrl(account),
          data: [summary({ full_name: `${account}/demo` })],
          etag: null,
          updatedAt: new Date(),
        });
      }
    }

    const app = createApp({
      store,
      accounts: ACCOUNTS,
      cacheTtlMs: 60_000,
      refreshIntervalMs: 300_000,
      corsOrigins,
    });

    await fn(
      async (path, init) =>
        await app.handle(new Request(`http://test.local${path}`, init)),
      store,
    );
  } finally {
    store.close();
  }
};

Deno.test("api: Healthcheck meldet den Cache-Stand je Account", async () => {
  await withApp(async (request) => {
    const res = await request("/");
    const body = await res.json();
    assertEquals(res.status, 200);
    assertEquals(body.status, "ok");
    assertEquals(body.accounts.length, 2);
    assertEquals(body.accounts[0].account, "dxdye");
    assertEquals(body.accounts[0].cached, true);
    assertEquals(body.accounts[0].repos, 1);
  });
});

Deno.test("api: liefert gecachte Repos ohne GitHub-Aufruf", async () => {
  await withApp(async (request) => {
    await withFetch([{ body: [] }], async (fetchMock) => {
      const res = await request("/github/dxdye/repos");
      const body = await res.json();

      assertEquals(res.status, 200);
      assertEquals(fetchMock.calls, 0);
      assertEquals(body.account, "dxdye");
      assertEquals(body.stale, false);
      assertEquals(body.count, 1);
      assertEquals(body.data[0].full_name, "dxdye/demo");
      assertStringIncludes(
        res.headers.get("cache-control") ?? "",
        "max-age=300",
      );
    });
  });
});

Deno.test("api: nicht konfigurierter Account ergibt 404", async () => {
  await withApp(async (request) => {
    await withFetch([{ body: [] }], async (fetchMock) => {
      const res = await request("/github/torvalds/repos");
      assertEquals(res.status, 404);
      assertEquals((await res.json()).error, "Account not configured");
      // Entscheidend: die Allowlist greift, bevor irgendetwas nach außen geht.
      assertEquals(fetchMock.calls, 0);
    });
  });
});

Deno.test("api: Pfad-Injektion im Account-Parameter erreicht GitHub nicht", async () => {
  await withApp(async (request) => {
    await withFetch([{ body: [] }], async (fetchMock) => {
      for (const evil of ["..%2F..%2Fadmin", "dxdye%2F..%2Fother", "%2E%2E"]) {
        const res = await request(`/github/${evil}/repos`);
        assertEquals(res.status, 404);
      }
      assertEquals(fetchMock.calls, 0);
    });
  });
});

Deno.test("api: setzt CORS-Header bei Wildcard", async () => {
  await withApp(async (request) => {
    const res = await request("/github/dxdye/repos", {
      headers: { Origin: "https://example.org" },
    });
    await res.body?.cancel();
    assertEquals(res.headers.get("access-control-allow-origin"), "*");
  });
});

Deno.test("api: beantwortet den Preflight mit CORS-Headern", async () => {
  await withApp(async (request) => {
    const res = await request("/github/dxdye/repos", {
      method: "OPTIONS",
      headers: { Origin: "https://example.org" },
    });
    await res.body?.cancel();

    assertEquals(res.status, 204);
    assertEquals(res.headers.get("access-control-allow-origin"), "*");
    assertStringIncludes(
      res.headers.get("access-control-allow-methods") ?? "",
      "GET",
    );
  });
});

Deno.test("api: erlaubte Origin wird gespiegelt, fremde nicht", async () => {
  await withApp(async (request) => {
    const allowed = await request("/github/dxdye/repos", {
      headers: { Origin: "https://pw23.dev" },
    });
    await allowed.body?.cancel();
    assertEquals(
      allowed.headers.get("access-control-allow-origin"),
      "https://pw23.dev",
    );
    assertEquals(allowed.headers.get("vary"), "Origin");

    const denied = await request("/github/dxdye/repos", {
      headers: { Origin: "https://evil.example" },
    });
    await denied.body?.cancel();
    assertEquals(denied.headers.get("access-control-allow-origin"), null);
  }, { corsOrigins: ["https://pw23.dev"] });
});

Deno.test("api: 500 verrät weder Stacktrace noch Fehlertext", async () => {
  await withApp(async (request) => {
    // Leerer Store + fehlschlagender Fetch: der Fehler erreicht den Handler.
    await withFetch(
      [{ status: 500, body: { message: "interner mongo pfad" } }],
      async () => {
        const res = await request("/github/dxdye/repos");
        const text = await res.text();

        assertEquals(res.status, 500);
        assertEquals(JSON.parse(text), { error: "Internal server error" });
        assertEquals(text.includes("stack"), false);
        assertEquals(text.includes("interner mongo pfad"), false);
      },
    );
  }, { prefill: false });
});

Deno.test("api: unbekannte Route ergibt 404 ohne Details", async () => {
  await withApp(async (request) => {
    const res = await request("/gibtsnicht");
    assertEquals(res.status, 404);
    assertEquals(await res.json(), { error: "Not found" });
  });
});

Deno.test("api: abgelaufener Cache wird bei GitHub-Ausfall stale ausgeliefert", async () => {
  await withApp(async (request, store) => {
    store.put({
      url: buildGithubReposUrl("dxdye"),
      data: [summary({ full_name: "dxdye/demo" })],
      etag: null,
      updatedAt: new Date(Date.now() - 10 * 60_000),
    });

    await withFetch([{ status: 503, rawBody: "unavailable" }], async () => {
      const res = await request("/github/dxdye/repos");
      const body = await res.json();
      assertEquals(res.status, 200);
      assertEquals(body.stale, true);
      assertEquals(body.data[0].full_name, "dxdye/demo");
    });
  });
});

Deno.test("api: füllt einen leeren Cache beim ersten Aufruf", async () => {
  await withApp(async (request, store) => {
    await withFetch([{ body: [rawRepo()] }], async (fetchMock) => {
      const res = await request("/github/dxdye/repos");
      const body = await res.json();

      assertEquals(fetchMock.calls, 1);
      assertEquals(body.count, 1);
      assertEquals(store.get(buildGithubReposUrl("dxdye"))?.data.length, 1);
    });
  }, { prefill: false });
});
