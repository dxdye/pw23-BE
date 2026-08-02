import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fetchRepos, GitHubError } from "../src/request.ts";
import { rawRepo, summary, withFetch } from "./helpers.ts";

const url = "https://api.github.com/users/dxdye/repos";

Deno.test("request: reduziert die Rohantwort auf die benötigten Felder", async () => {
  await withFetch([{ body: [rawRepo()] }], async () => {
    const result = await fetchRepos(url);
    assertEquals(result.status, "ok");
    if (result.status !== "ok") return;

    assertEquals(result.data, [summary()]);
    // Die URL-Templates aus der Rohantwort dürfen nicht durchrutschen.
    const keys = Object.keys(result.data[0]);
    assertEquals(keys.filter((key) => key.endsWith("_url")), ["html_url"]);
    assertEquals(keys.includes("node_id"), false);
    assertEquals(keys.includes("owner"), false);
  });
});

Deno.test("request: fragt 100 Repos pro Seite an", async () => {
  await withFetch([{ body: [rawRepo()] }], async (fetchMock) => {
    await fetchRepos(url);
    assertStringIncludes(fetchMock.urls[0], "per_page=100");
    assertStringIncludes(fetchMock.urls[0], "page=1");
  });
});

Deno.test("request: paginiert über volle Seiten hinweg", async () => {
  const fullPage = Array.from(
    { length: 100 },
    (_, index) => rawRepo({ id: index, name: `repo-${index}` }),
  );

  await withFetch(
    [
      { body: fullPage, headers: { etag: 'W/"seite-1"' } },
      { body: [rawRepo({ id: 999, name: "letztes" })] },
    ],
    async (fetchMock) => {
      const result = await fetchRepos(url);
      assertEquals(fetchMock.calls, 2);
      assertStringIncludes(fetchMock.urls[1], "page=2");
      if (result.status !== "ok") throw new Error("expected ok");
      assertEquals(result.data.length, 101);
      assertEquals(result.data[100].name, "letztes");
      // Der ETag der ersten Seite deckt nicht den Gesamtstand ab und darf
      // deshalb nicht gespeichert werden.
      assertEquals(result.etag, null);
    },
  );
});

Deno.test("request: sendet If-None-Match und meldet 304", async () => {
  await withFetch(
    [{ status: 304, headers: { etag: 'W/"abc"' } }],
    async (fetchMock) => {
      const result = await fetchRepos(url, 'W/"abc"');
      assertEquals(result.status, "not-modified");
      assertEquals(fetchMock.headers[0].get("if-none-match"), 'W/"abc"');
    },
  );
});

Deno.test("request: reicht den ETag einer einseitigen Antwort weiter", async () => {
  await withFetch(
    [{ body: [rawRepo()], headers: { etag: 'W/"frisch"' } }],
    async () => {
      const result = await fetchRepos(url);
      if (result.status !== "ok") throw new Error("expected ok");
      assertEquals(result.etag, 'W/"frisch"');
    },
  );
});

Deno.test("request: wirft bei erschöpftem Rate Limit", async () => {
  const resetAt = Math.floor(Date.now() / 1000) + 600;
  await withFetch(
    [{
      status: 403,
      body: { message: "API rate limit exceeded for 1.2.3.4." },
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetAt),
      },
    }],
    async () => {
      const error = await assertRejects(
        () => fetchRepos(url),
        GitHubError,
      );
      assertEquals(error.status, 403);
      assertStringIncludes(error.message, "rate limit");
    },
  );
});

Deno.test("request: wirft bei 404 statt den Fehlertext zu liefern", async () => {
  await withFetch(
    [{ status: 404, body: { message: "Not Found" } }],
    async () => {
      const error = await assertRejects(() => fetchRepos(url), GitHubError);
      assertEquals(error.status, 404);
    },
  );
});

Deno.test("request: wirft bei einem Objekt statt einer Repo-Liste", async () => {
  // 200 mit Objekt-Body - genau die Form, die früher als Repo-Liste im Cache
  // gelandet wäre.
  await withFetch([{ body: { message: "something else" } }], async () => {
    const error = await assertRejects(() => fetchRepos(url), GitHubError);
    assertStringIncludes(error.message, "instead of a repository array");
  });
});

Deno.test("request: wirft bei Nicht-JSON-Antwort", async () => {
  await withFetch(
    [{
      rawBody: "<html>502 Bad Gateway</html>",
      headers: { "Content-Type": "text/html" },
    }],
    async () => {
      const error = await assertRejects(() => fetchRepos(url), GitHubError);
      assertStringIncludes(error.message, "non-JSON");
    },
  );
});

Deno.test("request: setzt den Token als Bearer, wenn vorhanden", async () => {
  const before = Deno.env.get("GITHUB_TOKEN");
  Deno.env.set("GITHUB_TOKEN", "ghp_test");
  try {
    await withFetch([{ body: [] }], async (fetchMock) => {
      await fetchRepos(url);
      assertEquals(
        fetchMock.headers[0].get("authorization"),
        "Bearer ghp_test",
      );
    });
  } finally {
    if (before === undefined) Deno.env.delete("GITHUB_TOKEN");
    else Deno.env.set("GITHUB_TOKEN", before);
  }
});

Deno.test("request: ohne Token kein Authorization-Header", async () => {
  const before = Deno.env.get("GITHUB_TOKEN");
  Deno.env.delete("GITHUB_TOKEN");
  try {
    await withFetch([{ body: [] }], async (fetchMock) => {
      await fetchRepos(url);
      assertEquals(fetchMock.headers[0].get("authorization"), null);
    });
  } finally {
    if (before !== undefined) Deno.env.set("GITHUB_TOKEN", before);
  }
});
