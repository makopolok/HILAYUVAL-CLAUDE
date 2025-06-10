-- SQL migration for auditions table
CREATE TABLE IF NOT EXISTS auditions (
  id SERIAL PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  first_name_he TEXT,
  last_name_he TEXT,
  first_name_en TEXT,
  last_name_en TEXT,
  phone TEXT,
  email TEXT,
  agency TEXT,
  age INTEGER,
  height INTEGER,
  profile_pictures JSONB,
  showreel_url TEXT,
  video_url TEXT,
  video_type TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_auditions_project_id ON auditions(project_id);
CREATE INDEX IF NOT EXISTS idx_auditions_role ON auditions(role);
CREATE INDEX IF NOT EXISTS idx_auditions_email ON auditions(email);
