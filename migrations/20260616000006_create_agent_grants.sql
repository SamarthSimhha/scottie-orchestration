CREATE TABLE agent_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  granter_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  grantee_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  permission_level TEXT DEFAULT 'read'
    CHECK (permission_level IN ('read', 'write', 'admin')),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(granter_agent_id, grantee_agent_id)
);
