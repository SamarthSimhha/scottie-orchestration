CREATE TABLE agent_subscriptions (
  subscriber_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  publisher_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  subscribed_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (subscriber_agent_id, publisher_agent_id)
);
