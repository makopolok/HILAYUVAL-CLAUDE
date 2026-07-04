-- Idempotent-finalize backstop: prevent duplicate audition rows for the same
-- Bunny video GUID (e.g. from a retried form submit after a lost HTTP response).
--
-- Created inside a guard so it is safe on production data: if duplicate Bunny
-- video_url values already exist, the index is skipped (logged) rather than
-- failing the migration. Application-level idempotency still applies.
DO $$
BEGIN
  IF EXISTS (
    SELECT video_url
    FROM auditions
    WHERE video_type = 'bunny_stream' AND video_url IS NOT NULL
    GROUP BY video_url
    HAVING COUNT(*) > 1
  ) THEN
    RAISE NOTICE 'Skipping uq_auditions_bunny_guid: duplicate bunny_stream video_url values already exist';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_auditions_bunny_guid
      ON auditions (video_url)
      WHERE video_type = 'bunny_stream' AND video_url IS NOT NULL;
  END IF;
END $$;
