# PW23-BE (Backend)

This is the (micro-)backend of PW23.

It enables caching of the GitHub API calls that
were made by the frontend.
This circumvents the rate-limit of the GitHub API.
It also allows for an additional feature, tracking
the activity of the last 7 days.
So it transforms the GET-Requests into a
history per repository-name and username.

Also, it's the endpoint from which the website gets
exported.

## Docker usage

This service caches GitHub repository data for multiple accounts in PostgreSQL and
refreshes the cache on a cron schedule (default: every 5 minutes).
It maintains infinite version history with timestamp-based ordering.

### Start the app

```sh
docker compose up --build app
```

The endpoint is available at:

- `GET http://localhost:8000/github/{account}/repos` — Returns current cached data
- `GET http://localhost:8000/github/{account}/repos?history=5` — Returns last 5 cached versions (sorted by timestamp, newest last)

### Run tests

```sh
docker compose run --rm test
```

### Environment variables

- `DATABASE_URL` (default: `postgresql://localhost/pw23`) — PostgreSQL connection string
- `CACHE_TABLE` (default: `cache_entries`) — Name of the current cache table
- `VERSIONS_TABLE` (default: `cache_versions`) — Name of the version history table
- `GITHUB_ACCOUNTS` (comma-separated list, default: `dxdye`)
- `CACHE_REFRESH_CRON` (default: `*/5 * * * *`) — Cron schedule for cache refresh
- `CACHE_REFRESH_INTERVAL_MS` (default: `300000`) — Fallback interval in milliseconds (if cron not available)
- `PORT` (default: `8000`)
- `GITHUB_TOKEN` (optional: increases GitHub API rate limits)

You can copy `.env.example` to `.env` and edit it to set accounts and the cron schedule.

### Database Schema

The PostgreSQL database uses two tables:

**`cache_entries`** — Current cached data

- `url TEXT PRIMARY KEY` — GitHub API URL
- `data JSONB NOT NULL` — Cached repository data
- `updated_at TIMESTAMP` — Last update timestamp

**`cache_versions`** — Complete version history

- `id SERIAL PRIMARY KEY` — Version record ID
- `url TEXT` — Reference to cache_entries
- `data JSONB NOT NULL` — Historical repository data
- `updated_at TIMESTAMP` — Version timestamp
- `created_at TIMESTAMP` — Record creation time
- Indexed on `(url, updated_at DESC)` for efficient history retrieval

### Features

**Infinite Version History** — All cached versions are stored with timestamps
**Time-Machine Endpoint** — Use `?history=N` to get the last N versions
**Error-Safe Caching** — Failed GitHub API requests don't overwrite existing cache
**Automatic Schema Initialization** — PostgreSQL tables created on first run
**Comprehensive Logging** — Cache hits/misses and history counts logged
