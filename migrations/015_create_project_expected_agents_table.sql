BEGIN;

CREATE TABLE IF NOT EXISTS project_expected_agents (
  project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id INT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_project_expected_agents_agent_id ON project_expected_agents(agent_id);

COMMIT;
