# PW23-BE (Backend)

The (micro-)backend of PW23.

It caches the GitHub API calls the frontend would otherwise make itself, which
keeps the site working within GitHub's rate limit (60 requests/hour without a
token). A background job refreshes the cache; requests are served from SQLite
and never block on GitHub.

> **Scope.** This service is the _read path_ — current repository metadata per
> account. The Time Machine (persistent historisation, backfill, timeline
> materialisation) is a separate concern and is not part of this service; see
> `.cache/TIME_MACHINE.md`.

## Endpoints

| Endpoint                      | Returns                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| `GET /`                       | Health plus per-account cache state (`cached`, `updatedAt`, `repos`) |
| `GET /github/{account}/repos` | Cached repository list for a configured account                      |

`{account}` must be listed in `GITHUB_ACCOUNTS`; anything else returns 404
without making an outbound request.

Response shape:

```json
{
  "account": "dxdye",
  "url": "https://api.github.com/users/dxdye/repos",
  "updatedAt": "2026-08-02T22:45:12.021Z",
  "stale": false,
  "count": 11,
  "data": [{ "id": 1309356314, "name": "blackhole", "...": "..." }]
}
```

`stale: true` means the entry is older than the TTL and the refresh failed — the
last known good data is served rather than an error. That is the point of the
cache: a GitHub outage or an exhausted rate limit must not take the site down.

## How it works

- **Refresh loop** — one job per account, self-scheduling: the next run is only
  queued after the previous one finishes, so slow responses cannot cause
  overlapping runs.
- **Conditional requests** — the `ETag` of each response is stored and sent back
  as `If-None-Match`. A `304` does not count against the rate limit, so polling
  is effectively free as long as nothing changed.
- **Field projection** — GitHub sends ~81 fields per repo (43 of them URL
  templates); only the fields actually used are stored. Measured for `dxdye`: 61
  KB raw → 4.5 KB served.
- **Failure isolation** — non-`2xx` responses and non-array bodies throw and
  leave the store untouched, so a rate-limit message can never overwrite good
  data.
- **Single flight** — concurrent requests for the same account share one
  outbound fetch.

## Development

```sh
deno task dev     # watch mode
deno task test    # unit tests, no network or database needed
deno task check   # fmt + lint + typecheck
```

Tests stub `fetch` and use in-memory SQLite — nothing external has to run.

## Docker

```sh
docker compose up --build app     # start
docker compose run --rm test      # tests (profile: tools)
```

The cache lives in the `cache-data` volume at `/app/data/cache.db`. Keeping the
volume across restarts avoids re-fetching everything on boot.

## Environment variables

| Variable                    | Default             | Meaning                                      |
| --------------------------- | ------------------- | -------------------------------------------- |
| `PORT`                      | `8000`              | HTTP port                                    |
| `GITHUB_ACCOUNTS`           | `dxdye`             | Comma-separated accounts to cache            |
| `CACHE_DB_PATH`             | `./data/cache.db`   | SQLite file                                  |
| `CACHE_REFRESH_INTERVAL_MS` | `300000`            | Refresh interval                             |
| `CACHE_TTL_MS`              | 2× refresh interval | When an entry counts as stale                |
| `GITHUB_TIMEOUT_MS`         | `15000`             | Timeout per GitHub request                   |
| `CORS_ORIGINS`              | `*`                 | Comma-separated allowed origins              |
| `GITHUB_TOKEN`              | —                   | Optional; raises the rate limit to 5000/hour |

Invalid values fail at startup rather than silently degrading. Copy
`.env.example` to `.env` to get started.

> `CACHE_REFRESH_CRON` was removed. `Deno.cron` is only defined with
> `--unstable-cron`, so the cron branch never ran and the expression was
> silently ignored — the service always fell back to a fixed interval. The
> interval is now the only knob, and a leftover `CACHE_REFRESH_CRON` logs a
> warning at startup instead of pretending to work.
