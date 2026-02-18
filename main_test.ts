import { assertEquals } from "@std/assert";
import { stub, restore } from "@std/testing/mock";
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

  // Clean up any existing tables first
  try {
    await client.queryArray("DROP TABLE IF EXISTS cache_versions CASCADE");
    await client.queryArray("DROP TABLE IF EXISTS cache_entries CASCADE");
  } catch (_error) {
    // Ignore errors during cleanup
  }

  // Then initialize fresh tables
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

Deno.test("caches GitHub repositories response", async () => {
  const client = await createTestDb();

  try {
    const testPayload = [
      {
        html_url: "https://github.com/dxdye/example",
        full_name: "dxdye/example",
        description: "test repo",
        pushed_at: "2026-02-01T00:00:00Z",
        language: "TypeScript",
      },
    ];

    stub(globalThis, "fetch", () =>
      Promise.resolve(
        new Response(JSON.stringify(testPayload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    try {
      const url = buildGithubReposUrl("dxdye");

      // First call - should fetch from GitHub
      const cached1 = await getCachedOrFetch(client, url);
      assertEquals(cached1.data, testPayload);
      assertEquals(cached1.versions.length, 1);

      // Second call - should return cached data
      const cached2 = await getCachedOrFetch(client, url);
      assertEquals(cached2.data, testPayload);
      assertEquals(cached2.versions.length, 1);
    } finally {
      restore();
    }
  } finally {
    await cleanupTestDb(client);
  }
});

Deno.test("builds cache history with multiple fetches", async () => {
  const client = await createTestDb();

  try {
    const basePayload = {
      html_url: "https://github.com/test/repo",
      full_name: "test/repo",
      pushed_at: "2026-02-01T00:00:00Z",
      language: "TypeScript",
    };

    let callCount = 0;
    stub(globalThis, "fetch", () => {
      callCount++;
      const payload = [
        {
          ...basePayload,
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
      for (let i = 0; i < 3; i++) {
        await fetchAndCache(client, url);
      }

      // Get final cached version
      const cached = await getCachedOrFetch(client, url);

      // Should have 3 versions stored
      assertEquals(cached.versions.length, 3);

      // Latest version should be version-3
      const latestData = cached.versions.at(-1)?.data as unknown[] | undefined;
      assertEquals(
        (latestData?.[0] as Record<string, string>)?.description,
        "version-3",
      );
    } finally {
      restore();
    }
  } finally {
    await cleanupTestDb(client);
  }
});

Deno.test("keeps cache untouched on fetch error", async () => {
  const client = await createTestDb();
  const url = buildGithubReposUrl("dxdye");

  try {
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
    const _fetchStub1 = stub(globalThis, "fetch", () =>
      Promise.resolve(
        new Response(JSON.stringify(initialPayload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    try {
      // Initial cache
      await fetchAndCache(client, url);
    } finally {
      restore();
    }

    // Now stub with error response
    const _fetchStub2 = stub(globalThis, "fetch", () =>
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
        // Expected - error response should cause an error
      }

      // Verify cache is untouched
      const cached = await getCachedOrFetch(client, url);
      assertEquals(cached.data, initialPayload);

      // Should still only have 1 version (initial)
      assertEquals(cached.versions.length, 1);
    } finally {
      restore();
    }
  } finally {
    await cleanupTestDb(client);
  }
});
