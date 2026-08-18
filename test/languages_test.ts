import { assertEquals } from "@std/assert";
import { applyCached, selectStale } from "../src/languages.ts";
import type { LanguageEntry } from "../src/types.ts";
import { summary } from "./helpers.ts";

/** Cache-Lookup aus einem einfachen Objekt - kein Store, keine Datenbank. */
const lookup = (entries: Record<string, LanguageEntry>) => (fullName: string) =>
  entries[fullName] ?? null;

Deno.test("selectStale: unbekannte Repositories sind faellig", () => {
  const repos = [
    summary({ full_name: "a/one" }),
    summary({ full_name: "a/two" }),
  ];
  const stale = selectStale(repos, lookup({}));
  assertEquals(stale.map((r) => r.full_name), ["a/one", "a/two"]);
});

Deno.test("selectStale: unveraendertes pushed_at wird uebersprungen", () => {
  const repo = summary({
    full_name: "a/one",
    pushed_at: "2026-01-01T00:00:00Z",
  });
  const cached = lookup({
    "a/one": { pushedAt: "2026-01-01T00:00:00Z", languages: { Nix: 10 } },
  });
  assertEquals(selectStale([repo], cached), []);
});

Deno.test("selectStale: neues pushed_at macht wieder faellig", () => {
  const repo = summary({
    full_name: "a/one",
    pushed_at: "2026-02-01T00:00:00Z",
  });
  const cached = lookup({
    "a/one": { pushedAt: "2026-01-01T00:00:00Z", languages: { Nix: 10 } },
  });
  assertEquals(selectStale([repo], cached).length, 1);
});

Deno.test("selectStale: Budget begrenzt, zuletzt bespielte zuerst", () => {
  const repos = [
    summary({ full_name: "a/alt", pushed_at: "2024-01-01T00:00:00Z" }),
    summary({ full_name: "a/neu", pushed_at: "2026-08-01T00:00:00Z" }),
    summary({ full_name: "a/mittel", pushed_at: "2025-05-01T00:00:00Z" }),
  ];
  const stale = selectStale(repos, lookup({}), 2);
  assertEquals(stale.map((r) => r.full_name), ["a/neu", "a/mittel"]);
});

Deno.test("applyCached: haengt bekannte Sprachen an, laesst Unbekanntes null", () => {
  const repos = [
    summary({ full_name: "a/one" }),
    summary({ full_name: "a/two" }),
  ];
  const cached = lookup({
    "a/one": { pushedAt: "x", languages: { TypeScript: 100, Nix: 5 } },
  });
  const result = applyCached(repos, cached);
  assertEquals(result[0]?.languages, { TypeScript: 100, Nix: 5 });
  assertEquals(result[1]?.languages, null);
});
