ALTER TABLE agents
  ADD COLUMN persona TEXT DEFAULT 'nova_sage'
    CHECK (persona IN ('nova_sage', 'orion', 'volt')),
  ADD COLUMN persona_preferences JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN morning_briefing_enabled BOOLEAN DEFAULT true,
  ADD COLUMN morning_briefing_time TIME DEFAULT '09:00:00',
  ADD COLUMN standup_time TIME,
  ADD COLUMN timezone TEXT DEFAULT 'UTC';

ALTER TABLE agents ADD COLUMN github_username TEXT;
CREATE UNIQUE INDEX idx_agents_github_username ON agents(github_username)
  WHERE github_username IS NOT NULL;
