CREATE TABLE events_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source IN ('github', 'jira', 'linear', 'voice', 'manual', 'system')),
  event_type TEXT NOT NULL,
  target_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  raw_payload JSONB NOT NULL,
  parsed_payload JSONB,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'failed', 'dead_letter')),
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  received_at TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX idx_events_log_target ON events_log(target_agent_id);
CREATE INDEX idx_events_log_status ON events_log(status);
CREATE INDEX idx_events_log_received ON events_log(received_at DESC);
