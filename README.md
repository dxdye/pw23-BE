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

This service caches GitHub repository data for
`https://api.github.com/users/dxdye/repos` in MongoDB and
refreshes the cache on a cron-like interval (default: 5 minutes).

### Start the app

```sh
docker compose up --build app
```

The endpoint is available at:

- `GET http://localhost:8000/github/dxdye/repos`

### Run tests

```sh
docker compose run --rm test
```

### Environment variables

- `MONGO_URL` (default: `mongodb://localhost:27017`)
- `MONGO_DB` (default: `pw23`)
- `MONGO_COLLECTION` (default: `github_cache`)
- `CACHE_REFRESH_INTERVAL_MS` (default: `300000`)
- `PORT` (default: `8000`)
- `GITHUB_TOKEN` (optional: increases GitHub API rate limits)
