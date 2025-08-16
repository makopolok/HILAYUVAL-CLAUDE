-- Add soft-delete support to roles
ALTER TABLE IF EXISTS roles
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL;

-- Index to quickly filter active vs deleted per project
CREATE INDEX IF NOT EXISTS idx_roles_project_is_deleted ON roles(project_id, is_deleted);
