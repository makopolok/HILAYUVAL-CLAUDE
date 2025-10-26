-- Always keep updated_at fresh on touching rows
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create the projects table
CREATE TABLE projects (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL CHECK (btrim(name) <> ''),
    description TEXT,
    upload_method VARCHAR(50),
    player_mode VARCHAR(16) NOT NULL DEFAULT 'link',
    director VARCHAR(255),
    production_company VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enforce case-insensitive uniqueness on project names so duplicates cannot slip in
CREATE UNIQUE INDEX idx_projects_name_lower ON projects (LOWER(name));

-- Keep updated_at in sync on change
CREATE TRIGGER trg_projects_set_updated_at
BEFORE UPDATE ON projects
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Create the roles table
CREATE TABLE roles (
    id SERIAL PRIMARY KEY,
    project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL CHECK (btrim(name) <> ''),
    playlist_id VARCHAR(255),
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Prevent duplicate role names per project (case-insensitive)
CREATE UNIQUE INDEX idx_roles_project_name_lower ON roles (project_id, LOWER(name));

-- Support filtering active vs soft-deleted with the same index used in services
CREATE INDEX idx_roles_project_is_deleted ON roles(project_id, is_deleted);

CREATE TRIGGER trg_roles_set_updated_at
BEFORE UPDATE ON roles
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();