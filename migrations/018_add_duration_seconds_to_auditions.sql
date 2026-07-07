-- Add duration_seconds column to auditions for storing clip duration in seconds
BEGIN;

ALTER TABLE auditions
  ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;

COMMIT;
