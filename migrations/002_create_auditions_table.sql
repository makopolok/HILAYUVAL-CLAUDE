-- SQL migration for auditions table
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE auditions (
  id SERIAL PRIMARY KEY,
  project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (btrim(role) <> ''),
  first_name_he TEXT,
  last_name_he TEXT,
  first_name_en TEXT,
  last_name_en TEXT,
  phone TEXT,
  email TEXT,
  agency TEXT,
  age INTEGER,
  height INTEGER,
  profile_pictures JSONB DEFAULT '[]'::jsonb,
  showreel_url TEXT,
  video_url TEXT,
  video_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  search_full_name TEXT GENERATED ALWAYS AS (
    NULLIF(
      btrim(
        concat_ws(' ',
          COALESCE(NULLIF(btrim(first_name_en), ''), NULLIF(btrim(first_name_he), '')),
          COALESCE(NULLIF(btrim(last_name_en), ''), NULLIF(btrim(last_name_he), ''))
        )
      ),
      ''
    )
  ) STORED
);

CREATE TRIGGER trg_auditions_set_updated_at
BEFORE UPDATE ON auditions
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Useful indexes for frequent lookups
CREATE INDEX idx_auditions_project_created_at ON auditions (project_id, created_at DESC);
CREATE INDEX idx_auditions_project_role_lower ON auditions (project_id, LOWER(role));
CREATE INDEX idx_auditions_email_ci ON auditions ((LOWER(email)));
CREATE INDEX idx_auditions_name_exact_en ON auditions (LOWER(first_name_en), LOWER(last_name_en));
CREATE INDEX idx_auditions_name_exact_he ON auditions (first_name_he, last_name_he);
CREATE INDEX idx_auditions_search_full_name_trgm ON auditions USING gin (search_full_name gin_trgm_ops);
