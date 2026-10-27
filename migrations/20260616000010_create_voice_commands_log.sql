CREATE TABLE voice_commands_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  raw_transcript TEXT NOT NULL,
  intent_type TEXT NOT NULL,
  parsed_payload JSONB NOT NULL,
  confidence DECIMAL(4,3),
  executed BOOLEAN DEFAULT false,
  execution_result JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_voice_commands_agent ON voice_commands_log(agent_id);
CREATE INDEX idx_voice_commands_created ON voice_commands_log(created_at DESC);
