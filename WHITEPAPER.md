# Scottie Orchestration Layer — Technical Whitepaper

**Author:** Samarth Simha
**Published:** October 2026
**Repository:** github.com/samarthsimhha/scottie-orchestration
**Licence:** MIT

---

## Abstract

AI assistants are everywhere. They are not connected.

Every developer, knowledge worker, and field operator now has access to at least one AI tool. These tools have made individuals dramatically faster. But they share a common architectural flaw: each instance only knows what one person told it. The moment work transitions between people, context is lost entirely. Teams still coordinate manually, through the same Slack messages, standups, and catch-up calls that existed before AI arrived.

This whitepaper describes the orchestration layer at the core of Scottie — an open-source event-driven infrastructure that connects isolated AI agents through a shared contextual memory system. The layer handles real-time event ingestion from external tools, intent-driven context updates, permission-controlled cross-agent broadcasts, autonomous coordination jobs, and a scheduling system for intelligent reminders.

The orchestration layer is published as open source under MIT licence. It is designed to be the foundation on which any team-level AI coordination product can be built.

---

## 1. The Problem This Solves

### 1.1 The Isolation Problem

Modern AI tools operate on a per-user, per-session basis. A developer using GitHub Copilot has an assistant that knows their current file. A product manager using Claude has an assistant that knows their current conversation. A field agent using any AI tool has an assistant that knows what they typed into it today.

None of these assistants know anything about each other.

When a developer finishes a feature and hands it to a colleague, the colleague's AI starts from zero. When a nurse ends a shift and hands over to the next nurse, the incoming nurse's AI has no patient context. When a police officer radios in a pursuit, no other officer's AI is updated automatically.

This is not a model capability problem. Current AI models are capable of understanding and acting on complex team context. The problem is architectural: there is no shared layer that makes context available across agents in real time.

### 1.2 Why Existing Solutions Do Not Fix It

**Enterprise knowledge platforms** (Glean, Notion AI, Slack AI) index past documents and answer search queries. They are retrospective. They do not propagate real-time context between active agents.

**Multi-agent frameworks** (CrewAI, LangGraph, AutoGen) provide developer toolkits for building agent pipelines. They require significant engineering to deploy and produce no human-facing product. They are designed for automated workflows, not human team coordination.

**Company harnesses** (QM by Y Combinator) provide infrastructure for companies to build and run AI agent workflows. They are configured top-down by engineering teams and live primarily in Slack and browser interfaces. They have no voice interface and are not designed to give each individual their own personal AI agent.

The gap is a real-time, event-driven coordination layer that propagates context between personal AI agents automatically, with permission controls, voice input support, and cross-platform delivery.

That is what this orchestration layer provides.

---

## 2. Architecture Overview

The Scottie orchestration layer sits between the external world (webhooks from tools, voice commands from users) and the context store (the per-agent memory layer). It has four primary responsibilities:

1. **Event ingestion** — receiving events from any source and queuing them for processing
2. **Event parsing** — translating raw events into typed context updates
3. **Context updating** — applying updates to the correct agent's context store
4. **Broadcasting** — notifying relevant agents in real time when context changes

```
External Sources                    Internal Sources
GitHub / Jira / Linear              Voice commands / Manual API
         │                                    │
         ▼                                    ▼
   Webhook Receivers              POST /events/ingest
   (HMAC verified)                (JWT authenticated)
         │                                    │
         └──────────────┬─────────────────────┘
                        │
                        ▼
               Zod Schema Validation
               Payload size enforcement (50KB cap)
                        │
                        ▼
               events_log INSERT
               (status: 'pending')
                        │
                        ▼
            Redis Queue: events:pending
            (non-blocking rpush)
                        │
                        ▼ (worker consumes via blpop)
                  Event Parser
                  (EventPayload → ContextUpdate)
                        │
                        ▼
                Context Updater
                (array merge + PATCH to context store API)
                        │
                  ┌─────┴──────────────┐
                  ▼                    ▼
           Context Store          Redis pub/sub
           (Postgres, RLS)        agent:{id}:feed
                                  team:{id}:updates
                  │
                  ▼
         Trigger Evaluator
         (reminder matching)
                  │
                  ▼
         Autonomous Jobs
         (auto-handoff, PR routing)
                  │
                  ▼
         events_log UPDATE
         (status: 'processed')
```

All communication between the orchestration layer and the context store is via REST API. The orchestration layer never accesses the database directly. This maintains a clean architectural boundary and allows the context store to be replaced or scaled independently.

---

## 3. Event Ingestion

### 3.1 The Ingestion Endpoint

All events enter the system through a single endpoint: `POST /events/ingest`. This endpoint accepts events from three categories of source: external webhooks (after HMAC verification by their respective receivers), voice commands (from the AI layer after intent classification), and internal system events (autonomous jobs and scheduled triggers).

Every event conforms to the `EventPayload` type:

```typescript
interface EventPayload {
  source: 'github' | 'jira' | 'linear' | 'voice' | 'manual' | 'system';
  eventType: EventType;
  targetAgentId: string;       // UUID of the agent whose context should update
  rawPayload: Record<string, unknown>;
  receivedAt: string;          // ISO datetime
}
```

The endpoint validates the payload with Zod, enforces a 50KB payload size cap, inserts a record into `events_log` with status `pending`, pushes the event to the Redis queue, and returns 202 immediately. Processing is always asynchronous. The caller is never blocked.

### 3.2 Webhook Receivers

Three webhook receivers handle inbound events from external development tools. Each receiver applies its own rate limiting and performs HMAC signature verification before any payload processing occurs.

**GitHub** — verifies `X-Hub-Signature-256` using `crypto.timingSafeEqual()`. Handles `pull_request.assigned`, `pull_request.review_requested`, `pull_request.merged`, `pull_request.closed`, and `push` events.

**Jira** — verifies a secret token from headers or query parameters. Handles `jira:issue_updated` (assignee change), `jira:issue_updated` (status change), and `jira:issue_created`.

**Linear** — verifies `linear-signature` using `crypto.timingSafeEqual()`. Handles issue assignment and status change events.

`crypto.timingSafeEqual()` is used for all HMAC comparisons rather than string equality. Standard string comparison leaks timing information proportional to the number of matching characters, which can be exploited to forge signatures. Constant-time comparison eliminates this attack surface.

The receivers translate raw webhook payloads into `EventPayload` objects and POST them to `/events/ingest`. They always return 200 to the webhook sender, even on agent resolution failure. Webhook senders retry on non-200 responses, which would create duplicate events.

### 3.3 Agent Resolution

Webhook events arrive with usernames or email addresses, not agent IDs. Each receiver performs a resolution lookup:

```sql
SELECT id FROM agents
WHERE email = $1 OR name ILIKE $1
LIMIT 1
```

If no agent is found, the event is logged and dropped. It is not queued for retry. Unresolvable events are a configuration problem (the agent has not registered) rather than a processing problem.

---

## 4. The Worker Process

The worker is a standalone Node.js process that runs independently of the API server. It has no HTTP listener and no exposed ports. Its only communication is with the Redis queue (reads) and the context store API (writes).

### 4.1 Main Event Loop

```typescript
async function runWorker(): Promise<void> {
  while (true) {
    const event = await dequeueEvent(); // blpop with 5-second timeout
    if (event) {
      await processEvent(event);
    }
  }
}
```

`blpop` blocks for up to five seconds waiting for an event. On timeout it returns null and the loop continues. This is more efficient than polling and introduces no meaningful latency.

### 4.2 Retry and Dead Letter Logic

Each event carries a `retryCount` field. On processing failure:

- If `retryCount < 3`: the event is re-enqueued with `retryCount + 1`
- If `retryCount >= 3`: the event is pushed to `events:dead_letter` and the `events_log` record is updated to `dead_letter` status

The dead letter queue requires manual inspection. At MVP scale this is acceptable. At production scale, an alerting mechanism on dead letter queue depth is advisable.

### 4.3 Autonomous Jobs

After every event is processed, two autonomous coordination jobs run without requiring human initiation:

**Auto-handoff completion** — if the processed event is `task.completed` and the completing agent has a `pendingHandoff` in their context, the handoff is automatically completed. The system fetches the full context, generates a handoff summary via the AI layer, delivers it to the target agent's context, and clears the `pendingHandoff` field. The developer said "hand off X to Ravi when I finish" once. The system handles the rest.

**Smart PR review routing** — if the processed event is `pr.review_requested`, the system queries team members ranked by availability status and active task count, selects the least-loaded available reviewer, and broadcasts a review request to their agent. No human decides who reviews what.

```sql
SELECT a.id, a.name, co.availability,
       jsonb_array_length(co.active_tasks) AS task_count
FROM agents a
JOIN team_members tm ON tm.agent_id = a.id
JOIN context_objects co ON co.agent_id = a.id
WHERE tm.team_id = $1
  AND a.id != $2
  AND a.is_active = true
  AND co.availability IN ('available', 'busy')
ORDER BY
  CASE co.availability WHEN 'available' THEN 0 ELSE 1 END,
  jsonb_array_length(co.active_tasks) ASC
LIMIT 3
```

---

## 5. Event Parsing

The event parser translates a raw `EventPayload` into a typed `ContextUpdate`. It uses a switch on `eventType` to determine the correct patch to apply to the target agent's context and which agents should be notified.

```typescript
interface ContextUpdate {
  targetAgentId: string;
  updateType: EventType;
  patch: Partial<ContextObject>;  // fields to merge into context
  broadcastTo: string[];          // agent IDs to notify
  metadata: Record<string, unknown>;
}
```

Event type to context patch mappings:

| Event Type | Patch Fields |
|---|---|
| `pr.assigned` / `issue.assigned` | `activeTasks` (append), `currentStatus` |
| `pr.merged` / `task.completed` | `currentStatus` |
| `issue.status_changed` | `currentStatus` |
| `status.updated` | `currentStatus` |
| `handoff.initiated` | `pendingHandoff` |
| `blocker.added` | `blockers` (append) |
| `blocker.resolved` | `blockers` (resolve by ID) |
| `availability.changed` | `availability` |
| `decision.captured` | `recentDecisions` (append) |

Array fields are always appended, never replaced. `activeTasks` deduplicates by `ref` field before appending. This ensures that a PR assigned event does not create a duplicate task entry if the agent already has that PR in their active tasks.

---

## 6. Context Updating and Broadcasting

### 6.1 Context Update Application

The context updater applies a `ContextUpdate` to the target agent's context store. It fetches the current context, merges array fields, applies scalar updates, and PATCHes the result back via the context store API. It never writes directly to the database.

### 6.2 The speakMessage Field

Every broadcast message includes a `speakMessage` field. This is the natural language sentence that Scottie will speak aloud on the recipient's mobile device when their phone receives the broadcast.

```typescript
function generateSpeakMessage(
  eventType: EventType,
  fromName: string,
  recipientName: string,
  metadata: Record<string, unknown>
): string
```

Examples of generated speak messages:

- `pr.merged` — *"Hey Sam — Priya just merged the payments PR. You're clear to move forward."*
- `task.completed` — *"Hey Sam — Ravi just finished the auth service. You're clear to deploy."*
- `handoff.initiated` — *"Hey Sam — Priya has handed off the backend to you. I've got the full brief ready whenever you are."*
- `blocker.added` — *"Hey Sam — Ravi is blocked on the database migration. Might be worth a check-in."*

The message is generated once at the source and embedded in the Redis message payload. The mobile app speaks it using TTS without making an additional API call. This reduces latency on the notification path.

### 6.3 Redis Pub/Sub Channels

Broadcasts are published to named Redis channels:

| Channel | Purpose |
|---|---|
| `agent:{agentId}:feed` | Per-agent notifications targeting a specific individual |
| `team:{teamId}:updates` | Team-wide announcements, with excludeAgentId to prevent self-notification |

Broadcast targets are determined by:
1. Explicit `broadcastTo` list in the `ContextUpdate` (used for directed events like handoffs)
2. All team members except the originating agent (used for status updates and completions)

---

## 7. Reminder Scheduler

The reminder scheduler runs inside the worker process on a 60-second polling loop, concurrent with the main event queue consumer. It handles six reminder types with distinct scheduling logic.

### 7.1 Reminder Types

**Scheduled reminders** — fire at a specific `fire_at` datetime. Created explicitly by users via voice command ("Hey Scottie, remind the team about the deployment freeze tomorrow at 5pm") or API call.

**Handoff reminders** — a special case of scheduled reminders, automatically created when a handoff is initiated. Fire at a configurable delay after handoff to confirm the recipient has picked up the work.

**Blocker reminders** — automatically generated by the scheduler when a blocker has been unresolved for longer than the agent's configured threshold (default 4 hours). The scheduler queries all context objects for unresolved blockers:

```sql
SELECT co.agent_id, co.team_id, blocker
FROM context_objects co,
jsonb_array_elements(co.blockers) AS blocker
WHERE (blocker->>'resolvedAt') IS NULL
  AND (blocker->>'reportedAt')::timestamptz
      < NOW() - INTERVAL '1 hour' * $1
```

Before firing, the scheduler checks for a recent fire to prevent repeated notifications for the same blocker. A blocker that fired an alert within the past 4 hours is skipped.

**Standup reminders** — fire at each agent's configured `standup_time`. The scheduler compares the current time against agent standup time fields with one-minute precision.

**Trigger reminders** — fire when a specific event type is processed for a specific agent. Evaluated in the event pipeline immediately after context update, not in the scheduler loop. This gives zero-latency trigger responses.

**Announcement reminders** — scheduled reminders with `broadcast_to_team = true`. Fire at the configured time and broadcast to all team members simultaneously.

### 7.2 Deduplication

Blocker reminders use insertion-based deduplication: after firing, a `fired` reminder record is inserted with the blocker ID as `context_ref`. Before each fire cycle, the scheduler checks for this record within the past threshold period. This pattern avoids any locking or transaction complexity.

---

## 8. Security Design

Security is enforced at three levels: the infrastructure level, the application level, and the transport level.

**Infrastructure level** — Row Level Security (RLS) is enabled on the context objects table. The database engine itself enforces data isolation between teams. Even a bug in application code cannot expose cross-team data.

**Application level** — every API route requires JWT authentication. Rate limiting is applied at four tiers: general (100 req/15min), voice (30 req/15min), auth (20 req/15min), and webhooks (500 req/15min). All HMAC comparisons use `crypto.timingSafeEqual()`. All user text is sanitised before processing. Request bodies are capped at 50KB. Stack traces are never returned in production error responses.

**Transport level** — HTTPS enforced via HSTS headers with one-year max-age. CORS origin whitelist enforced. Helmet security headers on all responses.

**Voice and audio** — audio buffers are transcribed and immediately deleted from memory. Only the text transcript is stored. All transcription API calls are proxied through the backend server. No API keys are ever exposed in client-side code.

---

## 9. Data Model

The orchestration layer interacts with the following core tables. Full schema is in the repository.

**`events_log`** — audit trail for all events ingested. Every event is recorded with source, type, target, raw payload, processing status, retry count, and timestamps.

**`context_objects`** — one per agent. Contains `active_tasks`, `blockers`, `recent_decisions`, `current_status`, `availability`, `pending_handoff`, `last_handoff`, and `voice_history` as JSONB fields. RLS enforced.

**`reminders`** — all reminder types with their scheduling configuration, audience, trigger conditions, and firing history.

**`handoffs`** — records of handoff events between agents, including context snapshot at the time of handoff and acknowledgement status.

**`agent_subscriptions`** — pub/sub subscriptions between agents, used to determine broadcast targets.

---

## 10. Open Source Scope

The following components are published under MIT licence in this repository:

- Event ingestion endpoint (`/src/routes/events.ts`)
- Webhook receivers for GitHub, Jira, and Linear (`/src/routes/webhooks/`)
- Event parser (`/src/services/eventParser.ts`)
- Context updater with array merge logic (`/src/services/contextUpdater.ts`)
- Broadcaster service with `speakMessage` generation (`/src/services/broadcaster.ts`)
- Redis queue client (`/src/queues/eventQueue.ts`)
- Worker process with retry and dead letter logic (`/worker/src/`)
- Reminder scheduler with all six reminder types (`/worker/src/processors/reminderScheduler.ts`)
- Trigger evaluator (`/src/services/triggerEvaluator.ts`)
- Autonomous jobs: auto-handoff and PR routing (`/worker/src/processors/autonomousJobs.ts`)
- Security middleware (`/src/middleware/security.ts`)
- Complete database schema — all 13 migrations (`/migrations/`)
- Shared TypeScript types (`/packages/shared/`)

The following components remain proprietary and are not included in this repository:

- AI layer: intent classification, query resolution, handoff summarisation, personality engine
- Mobile application: wake word detection, TTS, push notifications, Lottie orb interface
- Production context store implementation and permission middleware
- Authentication integration

---

## 11. Getting Started

### Prerequisites

- Node.js 20+
- Docker Desktop (for local Postgres and Redis)
- An Anthropic or Google Gemini API key (for the AI layer, not included in this repo)

### Setup

```bash
git clone https://github.com/samarthsimhha/scottie-orchestration
cd scottie-orchestration
npm install
cp .env.example .env
# Fill in your values in .env
docker-compose up -d
npm run db:migrate
npm run dev:api
# In a second terminal:
npm run dev:worker
```

### Connecting Your First Webhook

Register a GitHub webhook pointing to `https://your-domain/webhooks/github` with content type `application/json` and a secret matching `GITHUB_WEBHOOK_SECRET` in your `.env`. Assign a PR to a registered agent. The event will flow through the pipeline and update the agent's context automatically.

---

## 12. Contributing

Contributions are welcome. The areas where external contributions would be most valuable:

- Additional webhook receivers (Notion, Asana, Trello, ServiceNow)
- Recurring reminder cron math implementation
- WebSocket server for real-time client subscriptions
- Improved agent resolution (fuzzy matching, explicit username mapping)
- Dead letter queue monitoring and alerting
- Load testing and throughput benchmarks

Please open an issue before submitting a pull request for significant changes.

---

## 13. Roadmap

The following features are planned for the orchestration layer:

- Acknowledgement protocol for the event queue (prevent event loss on worker crash)
- WebSocket / SSE endpoint for real-time client subscriptions
- Full cron expression parsing for recurring reminders
- Cross-organisation agent communication with federated permission controls
- Streaming context updates (partial updates without full context replacement)
- Metrics endpoint for coordination health monitoring

---

## Citation

If you use the Scottie orchestration layer in your research or product, please cite:

```
Simha, S. (2026). Scottie Orchestration Layer: An Open-Source Event-Driven
Infrastructure for Multi-Agent AI Coordination.
github.com/samarthsimhha/scottie-orchestration
```

---

## Licence

MIT Licence. Copyright 2026 Samarth Simha.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files, to deal in the software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the software.

---

*Built in public. Questions and feedback welcome at samarth.kempadhal-sridhar26@imperial.ac.uk*
