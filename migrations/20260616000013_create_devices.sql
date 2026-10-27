CREATE TABLE devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  push_token TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  device_name TEXT,
  voice_mode BOOLEAN DEFAULT true,
  speak_notifications TEXT DEFAULT 'all'
    CHECK (speak_notifications IN ('all', 'urgent', 'off')),
  is_active BOOLEAN DEFAULT true,
  registered_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(agent_id, push_token)
);

CREATE INDEX idx_devices_agent_id ON devices(agent_id);
CREATE INDEX idx_devices_push_token ON devices(push_token);
