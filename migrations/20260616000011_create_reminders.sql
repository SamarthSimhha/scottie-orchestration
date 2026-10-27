CREATE TABLE reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_by_agent_id UUID NOT NULL REFERENCES agents(id),
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,

  reminder_type TEXT NOT NULL CHECK (reminder_type IN (
    'trigger',
    'scheduled',
    'recurring',
    'blocker',
    'standup',
    'handoff',
    'announcement'
  )),

  title TEXT NOT NULL,
  message TEXT NOT NULL,
  context_ref TEXT,

  trigger_event_type TEXT,
  trigger_agent_id UUID REFERENCES agents(id),

  fire_at TIMESTAMPTZ,
  cron_expression TEXT,
  timezone TEXT DEFAULT 'UTC',

  blocker_threshold_hours INTEGER DEFAULT 4,

  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'fired', 'cancelled', 'snoozed')),
  fired_at TIMESTAMPTZ,
  snooze_until TIMESTAMPTZ,

  broadcast_to_team BOOLEAN DEFAULT false,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_reminders_agent_id ON reminders(agent_id);
CREATE INDEX idx_reminders_team_id ON reminders(team_id);
CREATE INDEX idx_reminders_status ON reminders(status);
CREATE INDEX idx_reminders_fire_at ON reminders(fire_at) WHERE status = 'active';
CREATE INDEX idx_reminders_trigger_event ON reminders(trigger_event_type) WHERE reminder_type = 'trigger';
