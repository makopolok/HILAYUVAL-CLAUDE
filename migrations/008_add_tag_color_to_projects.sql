ALTER TABLE projects
ADD COLUMN IF NOT EXISTS tag_color VARCHAR(20);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_projects_tag_color'
  ) THEN
    ALTER TABLE projects
    ADD CONSTRAINT chk_projects_tag_color
    CHECK (
      tag_color IS NULL OR
      tag_color IN ('gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple')
    );
  END IF;
END $$;
