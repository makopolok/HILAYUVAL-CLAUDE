-- Migration 013: per-project YouTube account storage
-- Stores OAuth refresh tokens for multiple Google/YouTube accounts so each
-- project can upload to a different YouTube channel.
-- Tokens are stored AES-256-GCM encrypted; the key is YOUTUBE_TOKEN_SECRET.

CREATE TABLE IF NOT EXISTS youtube_accounts (
  id              SERIAL PRIMARY KEY,
  display_name    VARCHAR(255) NOT NULL,          -- human label e.g. "Hila's Channel"
  email           VARCHAR(255),                   -- Google account email (informational)
  channel_id      VARCHAR(255) UNIQUE,            -- YouTube channel ID (UC...)
  channel_title   VARCHAR(255),                   -- YouTube channel display name
  -- AES-256-GCM encrypted refresh token: "iv:authTag:ciphertext" (all hex)
  encrypted_token TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_youtube_accounts_set_updated_at
BEFORE UPDATE ON youtube_accounts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Link projects to a YouTube account (NULL = fall back to GOOGLE_REFRESH_TOKEN env var)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'projects' AND column_name = 'youtube_account_id'
  ) THEN
    ALTER TABLE projects
      ADD COLUMN youtube_account_id INT REFERENCES youtube_accounts(id) ON DELETE SET NULL;
  END IF;
END;
$$;
