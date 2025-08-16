-- Add player_mode to projects: 'inline' (show iframe) or 'link' (show Open Video link)
ALTER TABLE projects
ADD COLUMN IF NOT EXISTS player_mode VARCHAR(16) NOT NULL DEFAULT 'link';
