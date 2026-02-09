import { assertEquals, assert } from "@std/assert";
import { stub } from "@std/testing/mock";
import {
  createMongoClient,
  DEFAULT_GITHUB_REPOS_URL,
  fetchAndCache,
  getCachedOrFetch,
  getCacheCollection,
} from "./cacheRoutine.ts";

const mongoUrl = Deno.env.get("MONGO_URL") ?? "mongodb://localhost:27017";

Deno.test("caches GitHub repositories response", async () => {
  const client = await createMongoClient(mongoUrl);
  const dbName = `pw23_test_${crypto.randomUUID()}`;
  const cacheCollection = getCacheCollection(client, dbName);

  const fakePayload = [
    {
      html_url: "https://github.com/dxdye/example",
      full_name: "dxdye/example",
      description: "demo",
      pushed_at: "2026-02-01T00:00:00Z",
      language: "TypeScript",
    },
  ];

  const fetchStub = stub(globalThis, "fetch", () =>
    Promise.resolve(
      new Response(JSON.stringify(fakePayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );

  try {
    const cached = await getCachedOrFetch(
      cacheCollection,
      DEFAULT_GITHUB_REPOS_URL,
    );

    assertEquals(cached.data, fakePayload);
    assert(cached.updatedAt instanceof Date);

    const updatedPayload = [{ ...fakePayload[0], description: "updated" }];
    fetchStub.restore();
    const secondFetchStub = stub(globalThis, "fetch", () =>
      Promise.resolve(
        new Response(JSON.stringify(updatedPayload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const refreshed = await fetchAndCache(
      cacheCollection,
      DEFAULT_GITHUB_REPOS_URL,
    );

    assertEquals(refreshed.data, updatedPayload);
    secondFetchStub.restore();
  } finally {
    await client.database(dbName).dropDatabase();
    await client.close();
  }
});
