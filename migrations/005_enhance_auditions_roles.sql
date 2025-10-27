-- Migration: strengthen auditions role integrity and add contact isolation
-- Applying these changes on a clean database is safe; for existing data ensure backups.

BEGIN;

-- Ensure we can rely on pgcrypto for future enhancements
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Align upload_method to a constrained domain across projects
ALTER TABLE projects
  ADD CONSTRAINT chk_projects_upload_method
  CHECK (
    upload_method IS NULL OR
    upload_method IN ('bunny_stream', 'cloudflare', 'youtube')
  );

-- Normalise role reference on auditions
ALTER TABLE auditions
  ADD COLUMN role_id INT REFERENCES roles(id) ON DELETE SET NULL,
  ADD COLUMN role_locked_name TEXT;

UPDATE auditions a
SET role_id = r.id,
    role_locked_name = a.role
FROM roles r
WHERE r.project_id = a.project_id
  AND LOWER(r.name) = LOWER(a.role)
  AND a.role_id IS NULL;

-- Default cached role name for legacy inserts
UPDATE auditions
SET role_locked_name = role
WHERE role_locked_name IS NULL;

ALTER TABLE auditions
  ALTER COLUMN role_locked_name SET DEFAULT '';

-- Keep historical role column as the cached display text
UPDATE auditions
SET role = COALESCE(role_locked_name, role);

-- Maintain fast lookup by role id
CREATE INDEX IF NOT EXISTS idx_auditions_role_id ON auditions(role_id);

-- Drop legacy email index prior to moving PII out
DROP INDEX IF EXISTS idx_auditions_email_ci;

-- Separate PII into its own table with cascading lifecycle
CREATE TABLE IF NOT EXISTS audition_contacts (
  audition_id INT PRIMARY KEY REFERENCES auditions(id) ON DELETE CASCADE,
  email TEXT,
  phone TEXT,
  agency TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill contacts from existing audition rows (if any)
INSERT INTO audition_contacts (audition_id, email, phone, agency)
SELECT id, email, phone, agency
FROM auditions a
WHERE NOT EXISTS (
  SELECT 1 FROM audition_contacts ac WHERE ac.audition_id = a.id
);

-- Remove PII columns from auditions now that they live in audition_contacts
ALTER TABLE auditions
  DROP COLUMN IF EXISTS email,
  DROP COLUMN IF EXISTS phone,
  DROP COLUMN IF EXISTS agency;

-- Trigger to keep audition_contacts.updated_at in sync
CREATE OR REPLACE FUNCTION trg_touch_audition_contacts()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audition_contacts_touch ON audition_contacts;
CREATE TRIGGER trg_audition_contacts_touch
BEFORE UPDATE ON audition_contacts
FOR EACH ROW
EXECUTE FUNCTION trg_touch_audition_contacts();

-- Keep cached role text aligned with FK
CREATE OR REPLACE FUNCTION trg_auditions_sync_role_name()
RETURNS TRIGGER AS $$
DECLARE
  role_name TEXT;
BEGIN
  IF NEW.role_id IS NOT NULL THEN
    SELECT name INTO role_name FROM roles WHERE id = NEW.role_id;
    IF role_name IS NULL THEN
      RAISE EXCEPTION 'Role % not found for audition %', NEW.role_id, NEW.id;
    END IF;
    NEW.role := role_name;
    NEW.role_locked_name := role_name;
  ELSE
    NEW.role := COALESCE(NULLIF(BTRIM(NEW.role), ''), NEW.role_locked_name);
    NEW.role_locked_name := NEW.role;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auditions_sync_role_name ON auditions;
CREATE TRIGGER trg_auditions_sync_role_name
BEFORE INSERT OR UPDATE ON auditions
FOR EACH ROW
EXECUTE FUNCTION trg_auditions_sync_role_name();

-- Cascade role rename into related auditions automatically
CREATE OR REPLACE FUNCTION trg_roles_propagate_name_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE auditions SET role = NEW.name, role_locked_name = NEW.name
    WHERE role_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_roles_propagate_name_change ON roles;
CREATE TRIGGER trg_roles_propagate_name_change
AFTER UPDATE OF name ON roles
FOR EACH ROW
EXECUTE FUNCTION trg_roles_propagate_name_change();

COMMIT;
