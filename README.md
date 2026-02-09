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

This service caches GitHub repository data for multiple accounts in MongoDB and
refreshes the cache on a cron schedule (default: every 5 minutes).

### Start the app

```sh
docker compose up --build app
```

The endpoint is available at:

- `GET http://localhost:8000/github/{account}/repos`
- `GET http://localhost:8000/github/{account}/repos?history=5` (last 5 cached versions)

### Run tests

```sh
docker compose run --rm test
```

### Environment variables

- `MONGO_URL` (default: `mongodb://localhost:27017`)
- `MONGO_DB` (default: `pw23`)
- `MONGO_COLLECTION` (default: `github_cache`)
- `GITHUB_ACCOUNTS` (comma-separated list, default: `dxdye`)
- `CACHE_REFRESH_CRON` (default: `*/5 * * * *`)
- `CACHE_MAX_VERSIONS` (default: `0` for unlimited history)
- `CACHE_CLEAR_ON_BSON` (default: `true`)
- `PORT` (default: `8000`)
- `GITHUB_TOKEN` (optional: increases GitHub API rate limits)

You can copy `.env.example` to `.env` and edit it to set accounts and the cron
schedule.
