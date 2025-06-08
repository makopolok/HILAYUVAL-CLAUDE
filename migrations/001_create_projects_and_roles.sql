-- SQL migration for projects and roles
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  upload_method TEXT,
  created_at TIMESTAMP,
  director TEXT,
  production_company TEXT
);

CREATE TABLE IF NOT EXISTS roles (
  id SERIAL PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  playlist_id TEXT
);
