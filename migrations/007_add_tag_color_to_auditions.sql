ALTER TABLE auditions
ADD COLUMN IF NOT EXISTS tag_color VARCHAR(20);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_auditions_tag_color'
  ) THEN
    ALTER TABLE auditions
    ADD CONSTRAINT chk_auditions_tag_color
    CHECK (
      tag_color IS NULL OR
      tag_color IN ('gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple')
    );
  END IF;
END $$;
