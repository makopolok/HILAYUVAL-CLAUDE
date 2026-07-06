BEGIN;

CREATE TABLE IF NOT EXISTS project_agent_requests (
  id SERIAL PRIMARY KEY,
  project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id INT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  actor_name TEXT NOT NULL,
  role_name TEXT,
  note TEXT,
  email_sent_at TIMESTAMPTZ,
  email_sent_to TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_agent_requests_project_id ON project_agent_requests(project_id);
CREATE INDEX IF NOT EXISTS idx_project_agent_requests_agent_id ON project_agent_requests(agent_id);

COMMIT;
