BEGIN;

CREATE TABLE IF NOT EXISTS agents (
  id SERIAL PRIMARY KEY,
  hebrew_name TEXT NOT NULL,
  english_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  search_aliases TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE auditions
  ADD COLUMN IF NOT EXISTS agent_id INT REFERENCES agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS agent_text TEXT;

CREATE INDEX IF NOT EXISTS idx_agents_active ON agents(active);
CREATE INDEX IF NOT EXISTS idx_agents_hebrew_lower ON agents(LOWER(hebrew_name));
CREATE INDEX IF NOT EXISTS idx_agents_english_lower ON agents(LOWER(english_name));

COMMIT;
