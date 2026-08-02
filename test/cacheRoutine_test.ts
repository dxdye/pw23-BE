import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  buildGithubReposUrl,
  fetchAndCache,
  getCachedOrFetch,
  startCacheRefresh,
} from "../src/cacheRoutine.ts";
import { createCacheStore } from "../src/store.ts";
import { GitHubError } from "../src/request.ts";
import { rawRepo, summary, withFetch } from "./helpers.ts";

const url = buildGithubReposUrl("dxdye");
const TTL = 60_000;

const withStore = async (
  fn: (store: ReturnType<typeof createCacheStore>) => Promise<void>,
) => {
  const store = createCacheStore(":memory:");
  try {
    await fn(store);
  } finally {
    store.close();
  }
};

Deno.test("cache: erster Aufruf holt, zweiter wird aus dem Cache bedient", async () => {
  await withStore(async (store) => {
    await withFetch([{ body: [rawRepo()] }], async (fetchMock) => {
      const first = await getCachedOrFetch(store, url, TTL);
      const second = await getCachedOrFetch(store, url, TTL);

      // Der eigentliche Zweck des Dienstes: der zweite Aufruf darf GitHub
      // nicht erreichen.
      assertEquals(fetchMock.calls, 1);
      assertEquals(first.data, [summary()]);
      assertEquals(second.data, [summary()]);
      assertEquals(second.stale, false);
    });
  });
});

Deno.test("cache: abgelaufener Eintrag wird neu geholt", async () => {
  await withStore(async (store) => {
    store.put({
      url,
      data: [summary({ description: "alt" })],
      etag: null,
      updatedAt: new Date(Date.now() - 10 * 60_000),
    });

    await withFetch(
      [{ body: [rawRepo({ description: "neu" })] }],
      async (fetchMock) => {
        const result = await getCachedOrFetch(store, url, TTL);
        assertEquals(fetchMock.calls, 1);
        assertEquals(result.data[0].description, "neu");
        assertEquals(result.stale, false);
      },
    );
  });
});

Deno.test("cache: Fehlerantwort überschreibt gute Daten nicht", async () => {
  await withStore(async (store) => {
    await withFetch([{ body: [rawRepo({ description: "gut" })] }], async () => {
      await fetchAndCache(store, url);
    });

    await withFetch(
      [{
        status: 403,
        body: { message: "API rate limit exceeded" },
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" },
      }],
      async () => {
        await assertRejects(() => fetchAndCache(store, url), GitHubError);
      },
    );

    // Früher landete `{"message": "..."}` hier als vermeintliche Repo-Liste.
    assertEquals(store.get(url)?.data[0].description, "gut");
  });
});

Deno.test("cache: liefert alte Daten, wenn der Refresh scheitert", async () => {
  await withStore(async (store) => {
    store.put({
      url,
      data: [summary({ description: "alt aber brauchbar" })],
      etag: null,
      updatedAt: new Date(Date.now() - 10 * 60_000),
    });

    await withFetch([{ status: 500, body: { message: "boom" } }], async () => {
      const result = await getCachedOrFetch(store, url, TTL);
      assertEquals(result.data[0].description, "alt aber brauchbar");
      assertEquals(result.stale, true);
    });
  });
});

Deno.test("cache: ohne Eintrag wird der Fehler durchgereicht", async () => {
  await withStore(async (store) => {
    await withFetch([{ status: 500, body: { message: "boom" } }], async () => {
      const error = await assertRejects(
        () => getCachedOrFetch(store, url, TTL),
        GitHubError,
      );
      assertEquals(error.status, 500);
    });
  });
});

Deno.test("cache: 304 behält die Daten und bestätigt die Frische", async () => {
  await withStore(async (store) => {
    const stale = new Date(Date.now() - 10 * 60_000);
    store.put({
      url,
      data: [summary({ description: "unverändert" })],
      etag: 'W/"abc"',
      updatedAt: stale,
    });

    await withFetch([{ status: 304 }], async (fetchMock) => {
      const result = await getCachedOrFetch(store, url, TTL);

      assertEquals(fetchMock.headers[0].get("if-none-match"), 'W/"abc"');
      assertEquals(result.data[0].description, "unverändert");
      assertEquals(result.stale, false);
      // Nach dem 304 gilt der Eintrag wieder als frisch.
      assertEquals(result.updatedAt.getTime() > stale.getTime(), true);
      assertEquals(store.get(url)!.updatedAt.getTime() > stale.getTime(), true);
    });
  });
});

Deno.test("cache: parallele Aufrufe lösen nur einen Fetch aus", async () => {
  await withStore(async (store) => {
    await withFetch([{ body: [rawRepo()] }], async (fetchMock) => {
      const results = await Promise.all([
        getCachedOrFetch(store, url, TTL),
        getCachedOrFetch(store, url, TTL),
        getCachedOrFetch(store, url, TTL),
      ]);

      assertEquals(fetchMock.calls, 1);
      results.forEach((result) => assertEquals(result.data, [summary()]));
    });
  });
});

Deno.test("cache: verschiedene Accounts werden getrennt gehalten", async () => {
  await withStore(async (store) => {
    await withFetch(
      (requested) =>
        requested.includes("/d2tsb/")
          ? { body: [rawRepo({ full_name: "d2tsb/other", name: "other" })] }
          : { body: [rawRepo()] },
      async () => {
        const a = await getCachedOrFetch(
          store,
          buildGithubReposUrl("dxdye"),
          TTL,
        );
        const b = await getCachedOrFetch(
          store,
          buildGithubReposUrl("d2tsb"),
          TTL,
        );
        assertEquals(a.data[0].full_name, "dxdye/blackhole");
        assertEquals(b.data[0].full_name, "d2tsb/other");
      },
    );
  });
});

Deno.test("refresh: läuft sofort und lässt sich stoppen", async () => {
  await withStore(async (store) => {
    await withFetch([{ body: [rawRepo()] }], async (fetchMock) => {
      const stop = startCacheRefresh(store, url, 50);
      await new Promise((resolve) => setTimeout(resolve, 180));
      stop();
      const callsAtStop = fetchMock.calls;

      // Mehrfach gelaufen, aber nach stop() kommt nichts mehr nach.
      assertEquals(callsAtStop >= 2, true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assertEquals(fetchMock.calls, callsAtStop);
    });
  });
});

Deno.test("refresh: ein Fehler beendet die Schleife nicht", async () => {
  await withStore(async (store) => {
    const responses = [
      { status: 500, body: { message: "boom" } },
      { body: [rawRepo()] },
    ];
    await withFetch(responses, async (fetchMock) => {
      const stop = startCacheRefresh(store, url, 40);
      await new Promise((resolve) => setTimeout(resolve, 150));
      stop();

      assertEquals(fetchMock.calls >= 2, true);
      // Nach dem Fehlschlag hat ein späterer Lauf den Cache doch noch gefüllt.
      assertEquals(store.get(url)?.data[0].full_name, "dxdye/blackhole");
    });
  });
});

Deno.test("cache: baut die GitHub-URL aus dem Account", () => {
  assertStringIncludes(buildGithubReposUrl("dxdye"), "/users/dxdye/repos");
});
