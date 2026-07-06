BEGIN;

ALTER TABLE project_expected_agents
  ADD COLUMN IF NOT EXISTS tag_color VARCHAR(20) NOT NULL DEFAULT 'yellow';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_project_expected_agents_tag_color'
  ) THEN
    ALTER TABLE project_expected_agents
      ADD CONSTRAINT chk_project_expected_agents_tag_color
      CHECK (tag_color IN ('gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'));
  END IF;
END $$;

COMMIT;
