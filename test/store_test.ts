import { assertEquals } from "@std/assert";
import { createCacheStore } from "../src/store.ts";
import { summary } from "./helpers.ts";

const url = "https://api.github.com/users/dxdye/repos";

Deno.test("store: liest zurück, was geschrieben wurde", () => {
  const store = createCacheStore(":memory:");
  try {
    const updatedAt = new Date("2026-08-01T12:00:00.000Z");
    store.put({ url, data: [summary()], etag: 'W/"abc"', updatedAt });

    const entry = store.get(url);
    assertEquals(entry?.url, url);
    assertEquals(entry?.data, [summary()]);
    assertEquals(entry?.etag, 'W/"abc"');
    assertEquals(entry?.updatedAt.toISOString(), updatedAt.toISOString());
  } finally {
    store.close();
  }
});

Deno.test("store: unbekannte URL liefert null", () => {
  const store = createCacheStore(":memory:");
  try {
    assertEquals(store.get("https://example.invalid/nope"), null);
  } finally {
    store.close();
  }
});

Deno.test("store: put überschreibt statt zu duplizieren", () => {
  const store = createCacheStore(":memory:");
  try {
    store.put({
      url,
      data: [summary({ name: "alt" })],
      etag: null,
      updatedAt: new Date("2026-08-01T12:00:00.000Z"),
    });
    store.put({
      url,
      data: [summary({ name: "neu" })],
      etag: null,
      updatedAt: new Date("2026-08-01T13:00:00.000Z"),
    });

    // Der Primärschlüssel auf url macht das Upsert eindeutig - ohne ihn könnten
    // parallele Läufe zwei Zeilen für denselben Account anlegen.
    assertEquals(store.get(url)?.data.length, 1);
    assertEquals(store.get(url)?.data[0].name, "neu");
  } finally {
    store.close();
  }
});

Deno.test("store: touch aktualisiert nur die Frische, nicht die Daten", () => {
  const store = createCacheStore(":memory:");
  try {
    store.put({
      url,
      data: [summary()],
      etag: 'W/"abc"',
      updatedAt: new Date("2026-08-01T12:00:00.000Z"),
    });

    const later = new Date("2026-08-01T13:00:00.000Z");
    store.touch(url, later, 'W/"abc"');

    const entry = store.get(url);
    assertEquals(entry?.updatedAt.toISOString(), later.toISOString());
    assertEquals(entry?.data, [summary()]);
  } finally {
    store.close();
  }
});

Deno.test("store: überdauert das Schließen der Datenbank", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/cache.db`;
  try {
    const first = createCacheStore(path);
    first.put({
      url,
      data: [summary()],
      etag: null,
      updatedAt: new Date("2026-08-01T12:00:00.000Z"),
    });
    first.close();

    const second = createCacheStore(path);
    assertEquals(second.get(url)?.data[0].full_name, "dxdye/blackhole");
    second.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("store: legt fehlende Verzeichnisse an", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/nested/deeper/cache.db`;
  try {
    const store = createCacheStore(path);
    store.close();
    assertEquals((await Deno.stat(path)).isFile, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
