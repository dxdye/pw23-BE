import { config } from "./config.ts";
import { createApp } from "./app.ts";
import { createCacheStore } from "./store.ts";
import { buildGithubReposUrl, startCacheRefresh } from "./cacheRoutine.ts";

const store = createCacheStore(config.dbPath);

const stopRefresh = config.accounts.map((account) =>
  startCacheRefresh(
    store,
    buildGithubReposUrl(account),
    config.refreshIntervalMs,
    config.requestTimeoutMs,
  )
);

const app = createApp({
  store,
  accounts: config.accounts,
  cacheTtlMs: config.cacheTtlMs,
  refreshIntervalMs: config.refreshIntervalMs,
  requestTimeoutMs: config.requestTimeoutMs,
  corsOrigins: config.corsOrigins,
});

const server = app.listen(config.port);
console.log(`Server running on http://localhost:${config.port}`);
console.log(
  `Caching ${config.accounts.join(", ")} every ${
    config.refreshIntervalMs / 1000
  }s into ${config.dbPath}`,
);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  stopRefresh.forEach((stop) => stop());
  // deno-lint-ignore no-explicit-any
  await (server as any)?.shutdown?.();
  store.close();
  Deno.exit(0);
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  try {
    Deno.addSignalListener(signal, () => void shutdown(signal));
  } catch {
    // Nicht jede Plattform kennt jedes Signal.
  }
}
