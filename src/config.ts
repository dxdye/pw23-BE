import { load } from "@std/dotenv";

// Diese Datei ist die einzige Stelle, die Konfiguration aus der Umgebung liest.
// Grund: ESM wertet Importe vor dem Modulkörper des Importeurs aus. Stand
// `await load()` in main.ts, liefen die Top-Level-`Deno.env.get()` der
// importierten Module vorher - Werte aus `.env` kamen dort nie an. Weil hier
// das Laden und das Lesen im selben Modul liegen, kann sich das nicht
// wiederholen; alle anderen Module bekommen ihre Konfiguration als Parameter.
await load({ export: true });

const raw = (key: string) => {
  const value = Deno.env.get(key);
  return value === undefined || value.trim() === "" ? undefined : value.trim();
};

const num = (
  key: string,
  fallback: number,
  { min = 1, max = Infinity } = {},
) => {
  const value = raw(key);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `${key}="${value}" is not a number between ${min} and ${max}`,
    );
  }
  return parsed;
};

const list = (key: string, fallback: string[]) => {
  const value = raw(key);
  if (value === undefined) return fallback;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) throw new Error(`${key}="${value}" is empty`);
  return items;
};

export const DEFAULT_GITHUB_ACCOUNT = "dxdye";

const refreshIntervalMs = num("CACHE_REFRESH_INTERVAL_MS", 5 * 60 * 1000, {
  min: 1000,
});

export const config = {
  port: num("PORT", 8000, { min: 1, max: 65535 }),
  accounts: list("GITHUB_ACCOUNTS", [DEFAULT_GITHUB_ACCOUNT]),
  dbPath: raw("CACHE_DB_PATH") ?? "./data/cache.db",
  refreshIntervalMs,
  // Ab wann eine Antwort aus dem Store als überholt gilt. Großzügiger als das
  // Refresh-Intervall, damit ein einzelner fehlgeschlagener Poll nicht sofort
  // einen Fetch im Request-Pfad auslöst.
  cacheTtlMs: num("CACHE_TTL_MS", refreshIntervalMs * 2, { min: 1000 }),
  requestTimeoutMs: num("GITHUB_TIMEOUT_MS", 15_000, { min: 1000 }),
  corsOrigins: list("CORS_ORIGINS", ["*"]),
} as const;

// `Deno.cron` existiert nur mit `--unstable-cron`, deshalb lief der Cron-Zweig
// nie und der Ausdruck wurde still ignoriert. Der Knopf heißt jetzt
// CACHE_REFRESH_INTERVAL_MS - wer den alten noch gesetzt hat, soll das merken.
if (raw("CACHE_REFRESH_CRON")) {
  console.warn(
    "CACHE_REFRESH_CRON is no longer supported and is being ignored. " +
      `Use CACHE_REFRESH_INTERVAL_MS instead (currently ${refreshIntervalMs} ms).`,
  );
}
