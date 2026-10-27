CREATE TABLE context_objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  team_id UUID REFERENCES teams(id) ON DELETE SET NULL,

  active_tasks JSONB DEFAULT '[]'::jsonb,
  completed_tasks JSONB DEFAULT '[]'::jsonb,
  blockers JSONB DEFAULT '[]'::jsonb,
  recent_decisions JSONB DEFAULT '[]'::jsonb,
  current_status TEXT,
  availability TEXT DEFAULT 'available'
    CHECK (availability IN ('available', 'busy', 'offline', 'heads_down')),

  last_handoff JSONB,
  pending_handoff JSONB,

  voice_history JSONB DEFAULT '[]'::jsonb,

  visibility TEXT DEFAULT 'team'
    CHECK (visibility IN ('public', 'team', 'private')),

  last_voice_update TIMESTAMPTZ,
  last_webhook_update TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_context_objects_agent_id ON context_objects(agent_id);
CREATE INDEX idx_context_objects_team_id ON context_objects(team_id);
CREATE INDEX idx_context_objects_owner ON context_objects(owner_user_id);

ALTER TABLE context_objects ENABLE ROW LEVEL SECURITY;
