BEGIN;

CREATE TABLE IF NOT EXISTS agent_contacts (
  id SERIAL PRIMARY KEY,
  agent_id INT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_contacts_primary
  ON agent_contacts(agent_id)
  WHERE is_primary = TRUE;

CREATE INDEX IF NOT EXISTS idx_agent_contacts_agent_id ON agent_contacts(agent_id);

COMMIT;
