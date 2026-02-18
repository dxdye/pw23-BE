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
refreshes the cache on a cron schedule (default: every minute).
It maintains infinite version history with timestamp-based ordering.

### Setup

1. Copy `.env.example` to `.env`:

   ```sh
   cp .env.example .env
   ```

2. Edit `.env` and customize your configuration:

   ```bash
   # PostgreSQL credentials and port
   DB_NAME=pw23
   DB_USER=cache_user
   DB_PASSWORD=your_secure_password  # Change this!
   DB_PORT=5433

   # GitHub accounts to cache
   GITHUB_ACCOUNTS=dxdye,d2tsb

   # Optional: GitHub token for higher rate limits
   GITHUB_TOKEN=ghp_your_token_here
   ```

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

### Reset the database

To clear all cache entries and version history:

```sh
docker compose run --rm reset-db
```

This will:

- Drop the `cache_versions` table (with cascade to remove FK constraints)
- Drop the `cache_entries` table
- Preserve the PostgreSQL database itself (useful for fresh starts or testing)

### Environment variables

All configuration is read from `.env` file. Key variables:

- `DB_NAME` (default: `pw23`) — PostgreSQL database name
- `DB_USER` (default: `cache_user`) — PostgreSQL user
- `DB_PASSWORD` (default: `cache_pass`) — PostgreSQL password. Change in production!
- `DB_PORT` (default: `5433`) — PostgreSQL port (external)
- `GITHUB_ACCOUNTS` (comma-separated list, default: `dxdye`) — GitHub accounts to cache
- `CACHE_REFRESH_CRON` (default: `*/1 * * * *`) — Cron schedule for cache refresh (every 1 minute)
- `PORT` (default: `8000`) — App server port
- `GITHUB_TOKEN` (optional) — GitHub personal access token for higher rate limits

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
