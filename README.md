# Scottie Orchestration Layer

**The open-source event-driven infrastructure for multi-agent AI coordination.**

[![MIT License](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15-blue.svg)](https://postgresql.org)
[![Redis](https://img.shields.io/badge/Redis-7-red.svg)](https://redis.io)

---

## What This Is

Every developer has an AI assistant. None of them know what the rest of the team is doing.

The Scottie orchestration layer is the infrastructure that fixes this. It connects isolated AI agents through a shared contextual memory system — propagating real-time context updates across team members automatically, with permission controls, voice input support, and cross-platform delivery.

When Priya finishes the backend and says "Hey Scottie, hand off to Ravi," Ravi's AI is briefed instantly. When a PR is assigned in GitHub, the receiving developer's agent context updates without anyone doing anything. When a blocker sits unresolved for four hours, the team lead is notified automatically.

This is the orchestration layer that makes that possible. It is open source under MIT.

---

## What Is Included

- Event ingestion pipeline with Redis queue
- Webhook receivers for GitHub, Jira, and Linear (HMAC verified)
- Event parser (raw events to typed context updates)
- Context updater with array merge logic
- Redis pub/sub broadcaster with `speakMessage` generation
- Background worker with retry and dead letter queue
- Reminder scheduler (six reminder types: scheduled, blocker, standup, trigger, handoff, announcement)
- Trigger evaluator (zero-latency reminder firing on event match)
- Autonomous jobs (auto-handoff completion, smart PR review routing)
- Security middleware (Helmet, CORS, four-tier rate limiting, input sanitisation)
- Complete PostgreSQL schema (13 migrations)
- Full TypeScript types

## What Is Not Included

- AI layer (intent classification, query resolution, handoff summarisation)
- Mobile application (wake word, TTS, push notifications)
- Authentication and permission middleware (production implementation)

---

## Quick Start

```bash
git clone https://github.com/samarthsimhha/scottie-orchestration
cd scottie-orchestration
npm install
cp .env.example .env
# Fill in your values
docker-compose up -d
npm run db:migrate
npm run dev:api
# Second terminal:
npm run dev:worker
```

---

## Architecture

```
External Sources          Internal Sources
GitHub / Jira / Linear    Voice / Manual
        │                       │
        ▼                       ▼
  Webhook Receivers    POST /events/ingest
  (HMAC verified)      (JWT authenticated)
        │                       │
        └──────────┬────────────┘
                   ▼
          Zod Validation + 50KB cap
                   ▼
           events_log INSERT
                   ▼
       Redis Queue: events:pending
                   ▼  (worker)
           Event Parser
                   ▼
         Context Updater
                   ▼
     Postgres ←──────────→ Redis pub/sub
     (context store)       (agent feeds)
                   ▼
         Trigger Evaluator
                   ▼
         Autonomous Jobs
```

Full architecture documentation and whitepaper: [WHITEPAPER.md](WHITEPAPER.md)

---

## Contributing

Contributions most needed:

- Additional webhook receivers (Notion, Asana, ServiceNow, Trello)
- Cron expression parsing for recurring reminders
- WebSocket server for real-time client subscriptions
- Dead letter queue monitoring
- Load testing benchmarks

Open an issue before submitting large PRs.

---

## Licence

MIT — Copyright 2026 Samarth Simha

---

*Part of the Scottie project. The internet for your AI agents.*
*samarth.kempadhal-sridhar26@imperial.ac.uk*
