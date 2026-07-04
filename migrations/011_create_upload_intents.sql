-- Durable upload intents for Bunny direct-to-storage uploads.
-- Replaces the in-memory Map (directUploadIntentStore) which does not survive
-- Heroku dyno restarts/deploys and is not shared across multiple dynos.
--
-- State machine:
--   intent_created -> token_issued -> upload_started -> uploaded -> processing -> completed
-- Terminal/exception states: expired, failed, orphaned
BEGIN;

CREATE TABLE IF NOT EXISTS upload_intents (
  id SERIAL PRIMARY KEY,
  intent_token UUID NOT NULL UNIQUE,
  guid TEXT NOT NULL UNIQUE,
  project_id INT REFERENCES projects(id) ON DELETE SET NULL,
  role_name TEXT,
  ip_address TEXT,
  state TEXT NOT NULL DEFAULT 'token_issued'
    CHECK (state IN (
      'intent_created',
      'token_issued',
      'upload_started',
      'uploaded',
      'processing',
      'completed',
      'expired',
      'failed',
      'orphaned'
    )),
  audition_id INT REFERENCES auditions(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reconciliation worker scans for stale, non-terminal intents by (state, expires_at).
CREATE INDEX IF NOT EXISTS idx_upload_intents_state_expires
  ON upload_intents (state, expires_at);

-- Keep updated_at fresh on any change (set_updated_at defined in 001).
DROP TRIGGER IF EXISTS trg_upload_intents_set_updated_at ON upload_intents;
CREATE TRIGGER trg_upload_intents_set_updated_at
BEFORE UPDATE ON upload_intents
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
