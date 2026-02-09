import { assertEquals, assert } from "@std/assert";
import { stub } from "@std/testing/mock";
import {
  createMongoClient,
  buildGithubReposUrl,
  fetchAndCache,
  getCachedOrFetch,
  getCacheCollection,
} from "./cacheRoutine.ts";

const mongoUrl = Deno.env.get("MONGO_URL") ?? "mongodb://localhost:27017";

Deno.test("caches GitHub repositories response", async () => {
  const client = await createMongoClient(mongoUrl);
  const dbName = `pw23_test_${crypto.randomUUID()}`;
  const cacheCollection = getCacheCollection(client, dbName);

  const dxdyePayload = [
    {
      html_url: "https://github.com/dxdye/example",
      full_name: "dxdye/example",
      description: "demo",
      pushed_at: "2026-02-01T00:00:00Z",
      language: "TypeScript",
    },
  ];

  const octoPayload = [
    {
      html_url: "https://github.com/octo/hello",
      full_name: "octo/hello",
      description: "octo",
      pushed_at: "2026-02-02T00:00:00Z",
      language: "Go",
    },
  ];

  const resolveUrl = (input: RequestInfo | URL) => {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    return input.url;
  };

  const fetchStub = stub(globalThis, "fetch", (input: RequestInfo | URL) => {
    const url = resolveUrl(input);
    const payload = url.includes("/octo/") ? octoPayload : dxdyePayload;
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  try {
    const dxdyeCached = await getCachedOrFetch(
      cacheCollection,
      buildGithubReposUrl("dxdye"),
    );

    const octoCached = await getCachedOrFetch(
      cacheCollection,
      buildGithubReposUrl("octo"),
    );

    assertEquals(dxdyeCached.data, dxdyePayload);
    assertEquals(octoCached.data, octoPayload);
    assert(dxdyeCached.updatedAt instanceof Date);
    assert(octoCached.updatedAt instanceof Date);

    const updatedPayload = [{ ...dxdyePayload[0], description: "updated" }];
    fetchStub.restore();
    const secondFetchStub = stub(
      globalThis,
      "fetch",
      (input: RequestInfo | URL) => {
        const url = resolveUrl(input);
        const payload = url.includes("/octo/") ? octoPayload : updatedPayload;
        return Promise.resolve(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      },
    );

    const refreshed = await fetchAndCache(
      cacheCollection,
      buildGithubReposUrl("dxdye"),
    );

    assertEquals(refreshed.data, updatedPayload);
    secondFetchStub.restore();
  } finally {
    await client.database(dbName).dropDatabase();
    await client.close();
  }
});
