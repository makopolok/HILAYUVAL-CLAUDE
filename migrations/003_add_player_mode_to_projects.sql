-- DEPRECATED: viewer-controlled inline vs link is now handled via ?mode=inline|link and DISABLE_INLINE_PLAYER.
-- This migration is no longer used. Do NOT apply it in production.
-- Add player_mode to projects: 'inline' (show iframe) or 'link' (show Open Video link)
ALTER TABLE projects
ADD COLUMN IF NOT EXISTS player_mode VARCHAR(16) NOT NULL DEFAULT 'link';
