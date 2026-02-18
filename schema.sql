-- PostgreSQL Schema for GitHub Cache with Time-Machine Version History
-- This schema supports infinite version history with timestamp-ordered retrieval

-- Main cache table storing the current entry
CREATE TABLE IF NOT EXISTS cache_entries (
  url TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Version history table storing all previous entries
CREATE TABLE IF NOT EXISTS cache_versions (
  id SERIAL PRIMARY KEY,
  url TEXT NOT NULL REFERENCES cache_entries(url) ON DELETE CASCADE,
  data JSONB NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Index for efficient version retrieval by URL and timestamp
CREATE INDEX IF NOT EXISTS idx_cache_versions_url_timestamp
  ON cache_versions(url, updated_at DESC);
