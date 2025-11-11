-- Add optional columns for tracking YouTube sync metadata per audition
BEGIN;

ALTER TABLE auditions
  ADD COLUMN IF NOT EXISTS youtube_video_id TEXT,
  ADD COLUMN IF NOT EXISTS youtube_video_url TEXT,
  ADD COLUMN IF NOT EXISTS youtube_synced_at TIMESTAMPTZ;

COMMIT;
