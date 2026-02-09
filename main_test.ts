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
    assertEquals(dxdyeCached.versions.length, 1);
    assertEquals(octoCached.versions.length, 1);

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
    assertEquals(refreshed.versions.length, 2);
    assertEquals(refreshed.versions.at(-1)?.data, updatedPayload);
    secondFetchStub.restore();
  } finally {
    await client.database(dbName).dropDatabase();
    await client.close();
  }
});

Deno.test("trims cache history to max versions", async () => {
  const client = await createMongoClient(mongoUrl);
  const dbName = `pw23_test_${crypto.randomUUID()}`;
  const cacheCollection = getCacheCollection(client, dbName);

  const payloads = [
    [
      {
        html_url: "https://github.com/dxdye/example",
        full_name: "dxdye/example",
        description: "v1",
        pushed_at: "2026-02-01T00:00:00Z",
        language: "TypeScript",
      },
    ],
    [
      {
        html_url: "https://github.com/dxdye/example",
        full_name: "dxdye/example",
        description: "v2",
        pushed_at: "2026-02-02T00:00:00Z",
        language: "TypeScript",
      },
    ],
    [
      {
        html_url: "https://github.com/dxdye/example",
        full_name: "dxdye/example",
        description: "v3",
        pushed_at: "2026-02-03T00:00:00Z",
        language: "TypeScript",
      },
    ],
  ];

  let callCount = 0;
  const fetchStub = stub(globalThis, "fetch", () => {
    const payload = payloads[Math.min(callCount, payloads.length - 1)];
    callCount += 1;
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  try {
    const url = buildGithubReposUrl("dxdye");
    await fetchAndCache(cacheCollection, url, 2);
    await fetchAndCache(cacheCollection, url, 2);
    const trimmed = await fetchAndCache(cacheCollection, url, 2);

    assertEquals(trimmed.versions.length, 2);
    assertEquals(trimmed.versions[0].data, payloads[1]);
    assertEquals(trimmed.versions[1].data, payloads[2]);
    assertEquals(trimmed.data, payloads[2]);
  } finally {
    fetchStub.restore();
    await client.database(dbName).dropDatabase();
    await client.close();
  }
});

Deno.test("keeps cache untouched on fetch error", async () => {
  const client = await createMongoClient(mongoUrl);
  const dbName = `pw23_test_${crypto.randomUUID()}`;
  const cacheCollection = getCacheCollection(client, dbName);

  const initialPayload = [
    {
      html_url: "https://github.com/dxdye/example",
      full_name: "dxdye/example",
      description: "initial",
      pushed_at: "2026-02-01T00:00:00Z",
      language: "TypeScript",
    },
  ];

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
    await fetchAndCache(cacheCollection, url, 0);
    fetchStub.restore();

    const errorStub = stub(globalThis, "fetch", () =>
      Promise.resolve(
        new Response("Not Found", {
          status: 404,
          statusText: "Not Found",
        }),
      ),
    );

    try {
      let threw = false;
      try {
        await fetchAndCache(cacheCollection, url, 0);
      } catch (_error) {
        threw = true;
      }

      assertEquals(threw, true);

      const cached = await getCachedOrFetch(cacheCollection, url);
      assertEquals(cached.data, initialPayload);
      assertEquals(cached.versions.length, 1);
    } finally {
      errorStub.restore();
    }
  } finally {
    await client.database(dbName).dropDatabase();
    await client.close();
  }
});
