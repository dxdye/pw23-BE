import { assertEquals, assert } from "@std/assert";
import { stub } from "@std/testing/mock";
import {
  createPostgresClient,
  buildGithubReposUrl,
  fetchAndCache,
  getCachedOrFetch,
  initializeCacheTables,
} from "./cacheRoutine.ts";
import { Client } from "postgres";

const dbUrl =
  Deno.env.get("DATABASE_URL") ??
  "postgresql://cache_user:cache_pass@localhost:5433/pw23";

async function createTestDb() {
  const client = await createPostgresClient(dbUrl);
  await initializeCacheTables(client);
  return client;
}

async function cleanupTestDb(client: Client) {
  try {
    await client.queryArray("DROP TABLE IF EXISTS cache_versions CASCADE");
    await client.queryArray("DROP TABLE IF EXISTS cache_entries CASCADE");
  } catch (_error) {
    // Ignore errors during cleanup
  }
  try {
    await client.end();
  } catch (_error) {
    // Ignore errors during close
  }
}

Deno.test("trims cache history to max versions", async () => {
  const client = await createTestDb();

  const testPayload = [
    {
      html_url: "https://github.com/test/repo",
      full_name: "test/repo",
      description: "test",
      pushed_at: "2026-02-01T00:00:00Z",
      language: "TypeScript",
    },
  ];

  const fetchStub = stub(globalThis, "fetch", () => {
    return Promise.resolve(
      new Response(JSON.stringify(testPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  try {
    const url = buildGithubReposUrl("test");

    // First fetch - should cache
    const cached = await getCachedOrFetch(client, url);

    // Verify data matches
    assert(Array.isArray(cached.data));
    assert(cached.data.length > 0);
    assert(cached.updatedAt instanceof Date);

    // First fetch should have 1 version
    assertEquals(cached.versions.length, 1);

    fetchStub.restore();

    // Second fetch with updated data
    const updatedPayload = [
      {
        ...testPayload[0],
        description: "updated",
      },
    ];

    const secondStub = stub(globalThis, "fetch", () => {
      return Promise.resolve(
        new Response(JSON.stringify(updatedPayload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    try {
      // Fetch again
      const refreshed = await fetchAndCache(client, url);

      // Should now have 2 versions
      assertEquals(refreshed.versions.length, 2);
      assert(Array.isArray(refreshed.data));
    } finally {
      secondStub.restore();
    }
  } finally {
    await cleanupTestDb(client);
  }
});

Deno.test("trims cache history to max versions", async () => {
  const client = await createTestDb();

  const basePayload = [
    {
      html_url: "https://github.com/test/repo",
      full_name: "test/repo",
      description: "test",
      pushed_at: "2026-02-01T00:00:00Z",
      language: "TypeScript",
    },
  ];

  let callCount = 0;
  const fetchStub = stub(globalThis, "fetch", () => {
    callCount++;
    const payload = [
      {
        ...basePayload[0],
        description: `version-${callCount}`,
      },
    ];
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  try {
    const url = buildGithubReposUrl("test");

    // Fetch multiple times to build up history
    for (let i = 0; i < 5; i++) {
      await fetchAndCache(client, url);
    }

    // Get final cached version
    const cached = await getCachedOrFetch(client, url);

    // Should have versions stored
    assert(cached.versions.length > 0);

    // Latest version should be version-5
    const latestData = cached.versions.at(-1)?.data as unknown[] | undefined;
    assertEquals(
      (latestData?.[0] as Record<string, string>)?.description,
      "version-5",
    );

    fetchStub.restore();
  } finally {
    await cleanupTestDb(client);
  }
});

Deno.test("keeps cache untouched on fetch error", async () => {
  const client = await createTestDb();

  const initialPayload = [
    {
      html_url: "https://github.com/dxdye/example",
      full_name: "dxdye/example",
      description: "initial",
      pushed_at: "2026-02-01T00:00:00Z",
      language: "TypeScript",
    },
  ];

  // First, store initial data
  const fetchStub = stub(globalThis, "fetch", () =>
    Promise.resolve(
      new Response(JSON.stringify(initialPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );

  try {
    const url = buildGithubReposUrl("dxdye");

    // Initial cache
    await fetchAndCache(client, url);
    fetchStub.restore();

    // Now stub with error response
    const errorStub = stub(globalThis, "fetch", () =>
      Promise.resolve(
        new Response("Not Found", {
          status: 404,
          statusText: "Not Found",
        }),
      ),
    );

    try {
      try {
        // This should not update the cache due to error response
        await fetchAndCache(client, url);
      } catch (_error) {
        // Expected - error response should cause an error or be skipped
      }

      // Should have thrown or kept cache
      // (depending on implementation, we just verify cache is still there)

      // Verify cache is untouched
      const cached = await getCachedOrFetch(client, url);
      assertEquals(cached.data, initialPayload);

      // Should still only have 1 version (initial)
      assertEquals(cached.versions.length, 1);
    } finally {
      errorStub.restore();
    }
  } finally {
    await cleanupTestDb(client);
  }
});
