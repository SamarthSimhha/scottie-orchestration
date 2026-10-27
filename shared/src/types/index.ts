// ─── Core Entity Types ────────────────────────────────────────────────────────

export interface Agent {
  id: string;
  userId: string;
  teamId: string | null;
  name: string;
  email: string | null;
  role: string | null;
  isActive: boolean;
  persona: PersonaType;
  githubUsername: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Team {
  id: string;
  name: string;
  orgName: string | null;
  plan: 'free' | 'team' | 'enterprise';
  createdAt: string;
  updatedAt: string;
}

export interface ActiveTask {
  id: string;
  title: string;
  ref: string | null;
  status: string;
  assignedAt: string;
  source: EventSource;
}

export interface Blocker {
  id: string;
  description: string;
  taskRef: string | null;
  reportedAt: string;
  resolvedAt: string | null;
}

export interface Decision {
  id: string;
  description: string;
  taskRef: string | null;
  madeAt: string;
  madeBy: string;
}

export interface HandoffPayload {
  fromAgentId: string;
  toAgentId: string;
  taskRef: string | null;
  summary: string;
  contextSnapshot: Partial<ContextObject>;
  createdAt: string;
}

export interface ContextObject {
  id: string;
  agentId: string;
  ownerUserId: string;
  teamId: string | null;
  activeTasks: ActiveTask[];
  completedTasks: ActiveTask[];
  blockers: Blocker[];
  recentDecisions: Decision[];
  currentStatus: string | null;
  availability: 'available' | 'busy' | 'offline' | 'heads_down';
  lastHandoff: HandoffPayload | null;
  pendingHandoff: HandoffPayload | null;
  voiceHistory: VoiceCommandRecord[];
  visibility: 'public' | 'team' | 'private';
  lastVoiceUpdate: string | null;
  lastWebhookUpdate: string | null;
  updatedAt: string;
  createdAt: string;
}

// ─── Event System Types ───────────────────────────────────────────────────────

export type EventSource =
  | 'github'
  | 'jira'
  | 'linear'
  | 'voice'
  | 'manual'
  | 'system';

export type EventType =
  | 'pr.assigned'
  | 'pr.review_requested'
  | 'pr.merged'
  | 'pr.closed'
  | 'issue.assigned'
  | 'issue.status_changed'
  | 'handoff.initiated'
  | 'handoff.acknowledged'
  | 'status.updated'
  | 'blocker.added'
  | 'blocker.resolved'
  | 'task.completed'
  | 'availability.changed'
  | 'decision.captured';

export interface EventPayload {
  source: EventSource;
  eventType: EventType;
  targetAgentId: string;
  rawPayload: Record<string, unknown>;
  receivedAt: string;
}

export interface ContextUpdate {
  targetAgentId: string;
  updateType: EventType;
  patch: Partial<ContextObject>;
  broadcastTo: string[];
  metadata: Record<string, unknown>;
}

// ─── Voice Command Types ──────────────────────────────────────────────────────

export type IntentType =
  | 'STATUS_UPDATE'
  | 'BLOCKER_UPDATE'
  | 'BLOCKER_RESOLVED'
  | 'HANDOFF'
  | 'CONTEXT_QUERY'
  | 'TASK_COMPLETE'
  | 'PR_READY'
  | 'STANDUP'
  | 'AVAILABILITY'
  | 'DECISION_CAPTURED'
  | 'SET_REMINDER'
  | 'CANCEL_REMINDER'
  | 'MORNING_BRIEFING'
  | 'UNCLEAR';

export interface VoiceCommandPayload {
  intentType: IntentType;
  taskRef: string | null;
  targetPerson: string | null;
  status: string | null;
  rawMessage: string;
  confidence: number;
  extractedEntities: Record<string, string>;
}

export interface VoiceCommandRecord {
  id: string;
  rawTranscript: string;
  intentType: IntentType;
  parsedPayload: VoiceCommandPayload;
  confidence: number;
  executedAt: string;
}

// ─── API Response Types ───────────────────────────────────────────────────────

export interface ApiResponse<T> {
  data: T | null;
  error: { message: string; code: string } | null;
}

export interface QueryResponse {
  answer: string;
  sources: string[];
  confidence: number;
}

// ─── Reminder Types ───────────────────────────────────────────────────────────

export type ReminderType =
  | 'trigger'
  | 'scheduled'
  | 'recurring'
  | 'blocker'
  | 'standup'
  | 'handoff'
  | 'announcement';

export type ReminderStatus = 'active' | 'fired' | 'cancelled' | 'snoozed';

export interface Reminder {
  id: string;
  agentId: string;
  createdByAgentId: string;
  teamId: string | null;
  reminderType: ReminderType;
  title: string;
  message: string;
  contextRef: string | null;
  triggerEventType: string | null;
  triggerAgentId: string | null;
  fireAt: string | null;
  cronExpression: string | null;
  timezone: string;
  blockerThresholdHours: number;
  broadcastToTeam: boolean;
  status: ReminderStatus;
  firedAt: string | null;
  snoozeUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Persona Types (minimal) ──────────────────────────────────────────────────

export type PersonaType = 'nova_sage' | 'orion' | 'volt';

export interface AgentPersona {
  persona: PersonaType;
  morningBriefingEnabled: boolean;
  morningBriefingTime: string;
  standupTime: string | null;
  timezone: string;
}
