import type { EventType } from '@scottie/shared';
import { query } from '../db/connection';
import { publishToChannel } from '../queues/eventQueue';
import type { ContextUpdateResult } from './contextUpdater';

// ── Public types ──────────────────────────────────────────────────────────────

export interface BroadcastMessage {
  type: 'context_update' | 'handoff_request' | 'blocker_alert' | 'status_change';
  fromAgentId: string;
  payload: Record<string, unknown>;
  speakMessage: string;
  timestamp: string;
}

export interface BroadcastResult {
  deliveredCount: number;
  failedCount: number;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function messageTypeFor(eventType: EventType): BroadcastMessage['type'] {
  switch (eventType) {
    case 'handoff.initiated':
    case 'handoff.acknowledged':
      return 'handoff_request';

    case 'blocker.added':
    case 'blocker.resolved':
      return 'blocker_alert';

    case 'status.updated':
    case 'availability.changed':
    case 'task.completed':
    case 'decision.captured':
      return 'status_change';

    default:
      return 'context_update';
  }
}

function safeStr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

// ── speakMessage generator ────────────────────────────────────────────────────

/**
 * Generates the sentence Scottie speaks aloud on the recipient's phone.
 *
 * Rules (from CLAUDE.md):
 *   - Maximum 2 sentences
 *   - Starts with "Hey [name] — " when recipientName is known
 *   - Nova+Sage tone: warm, direct, actionable — never robotic
 *   - Must stand alone when spoken; no external context assumed
 *   - Falls back gracefully when metadata fields are missing
 *
 * Pure function — no I/O, exported for independent testing.
 */
export function generateSpeakMessage(
  eventType: EventType,
  fromName: string,
  recipientName: string,
  metadata: Record<string, unknown>,
): string {
  const hey  = recipientName.length > 0 ? `Hey ${recipientName} — ` : '';
  const from = fromName.length > 0 ? fromName : 'Your teammate';

  switch (eventType) {
    case 'pr.assigned':
      return `${hey}${from} assigned you a PR: ${safeStr(metadata.prTitle, 'a new pull request')}. Take a look when you get a chance.`;

    case 'pr.review_requested':
      return `${hey}${from} needs your review on ${safeStr(metadata.prTitle, 'a PR')}. You were picked because your plate looks lightest right now.`;

    case 'pr.merged':
      return `${hey}${from} just merged ${safeStr(metadata.prTitle, 'a PR')}. You're clear to move forward.`;

    case 'pr.closed':
      return `${hey}${from} closed ${safeStr(metadata.prTitle, 'a PR')} without merging.`;

    case 'issue.assigned':
      return `${hey}${from} assigned you ${safeStr(metadata.issueSummary, 'a new issue')}.`;

    case 'issue.status_changed':
      return `${hey}${from} updated ${safeStr(metadata.issueSummary, 'an issue')} to ${safeStr(metadata.issueStatus, 'a new status')}.`;

    case 'handoff.initiated':
      return `${hey}${from} has handed off ${safeStr(metadata.taskRef, 'some work')} to you. I've got the full brief ready whenever you are.`;

    case 'handoff.acknowledged':
      return `${hey}${from} has picked up your handoff on ${safeStr(metadata.taskRef, 'that task')}. They're on it.`;

    case 'status.updated':
      return `${hey}${from} updated their status: ${safeStr(metadata.statusMessage, 'new update available')}.`;

    case 'blocker.added': {
      const ref = safeStr(metadata.taskRef ?? metadata.blockerDescription, 'something');
      return `${hey}${from} is blocked on ${ref}. Might be worth a quick check-in.`;
    }

    case 'blocker.resolved': {
      const ref = safeStr(metadata.taskRef ?? metadata.blockerDescription, 'that blocker');
      return `${hey}${from} cleared their blocker on ${ref}. Things are moving again.`;
    }

    case 'task.completed': {
      const ref = safeStr(metadata.taskRef ?? metadata.prTitle, 'a task');
      return `${hey}${from} just finished ${ref}. You're clear to move forward.`;
    }

    case 'availability.changed': {
      const avail = String(metadata.availability ?? '');
      const phrases: Record<string, string> = {
        available:   'is back and available',
        busy:        'is busy for now',
        offline:     'has gone offline',
        heads_down:  'is heads down and not to be disturbed',
      };
      const phrase = phrases[avail] ?? 'changed their availability';
      return `${hey}${from} ${phrase}.`;
    }

    case 'decision.captured':
      return `${hey}${from} recorded a decision about ${safeStr(metadata.taskRef, 'the project')}. It's saved in the team context.`;

    default: {
      // Exhaustiveness guard — TypeScript will flag unhandled EventTypes here
      const _exhaustive: never = eventType;
      void _exhaustive;
      return `${hey}${from} has an update for you.`;
    }
  }
}

// ── Delivery ──────────────────────────────────────────────────────────────────

/**
 * Publishes a BroadcastMessage to a single agent's Redis feed channel.
 * Exported so the Worker's reminder scheduler can reuse it directly.
 */
export async function broadcastToAgent(
  toAgentId: string,
  message: BroadcastMessage,
): Promise<void> {
  await publishToChannel(`agent:${toAgentId}:feed`, { ...message });
}

/**
 * Publishes the same BroadcastMessage to every active member of a team.
 * Exported so the Worker's reminder scheduler can reuse recipient resolution
 * instead of duplicating the team_members join.
 *
 * excludeAgentId is optional — omit it to notify the whole team (e.g. standup
 * prompts); pass it to skip one member (e.g. the agent a blocker alert already
 * went to individually).
 *
 * Per-recipient failures are isolated, same contract as broadcastUpdate.
 */
export async function broadcastToTeam(
  teamId: string,
  message: BroadcastMessage,
  excludeAgentId?: string,
): Promise<BroadcastResult> {
  const rows = await query<{ id: string }>(
    `SELECT a.id
     FROM agents a
     JOIN team_members tm ON tm.agent_id = a.id
     WHERE tm.team_id = $1
       AND a.is_active = true
       AND ($2::uuid IS NULL OR a.id != $2)`,
    [teamId, excludeAgentId ?? null],
  );

  let deliveredCount = 0;
  let failedCount = 0;

  for (const row of rows) {
    try {
      await broadcastToAgent(row.id, message);
      deliveredCount++;
    } catch (err: unknown) {
      failedCount++;
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.log(
        JSON.stringify({
          level: 'error',
          message: 'Failed to broadcast to team recipient',
          teamId,
          recipientAgentId: row.id,
          error: errorMessage,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }

  return { deliveredCount, failedCount };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Resolves recipients for a ContextUpdateResult, constructs a personalised
 * BroadcastMessage for each, and publishes to their Redis channels.
 *
 * Recipient resolution:
 *   - Uses explicitBroadcastTargets when non-empty (e.g. handoff.initiated)
 *   - Falls back to all active team members (excluding the source agent)
 *   - Returns {deliveredCount: 0, failedCount: 0} when there are no recipients
 *
 * Per-recipient failures are isolated: one failed publish does not block others.
 * The Worker should log BroadcastResult but treat it as informational — a failed
 * notification does not mean the context update failed.
 */
export async function broadcastUpdate(
  result: ContextUpdateResult,
): Promise<BroadcastResult> {
  const { agentId: fromAgentId, teamId, updateType, explicitBroadcastTargets, summary, metadata } = result;

  // ── 1. Resolve recipient IDs ───────────────────────────────────────────────
  let recipientIds: string[];

  if (explicitBroadcastTargets.length > 0) {
    recipientIds = explicitBroadcastTargets;
  } else if (teamId !== null) {
    const rows = await query<{ id: string }>(
      `SELECT a.id
       FROM agents a
       JOIN team_members tm ON tm.agent_id = a.id
       WHERE tm.team_id = $1
         AND a.id != $2
         AND a.is_active = true`,
      [teamId, fromAgentId],
    );
    recipientIds = rows.map((r) => r.id);
  } else {
    recipientIds = [];
  }

  if (recipientIds.length === 0) {
    console.log(
      JSON.stringify({
        level: 'info',
        message: 'Broadcast skipped — no recipients',
        agentId: fromAgentId,
        updateType,
        timestamp: new Date().toISOString(),
      }),
    );
    return { deliveredCount: 0, failedCount: 0 };
  }

  // ── 2. Batch-fetch agent names (from-agent + all recipients in one query) ──
  const allIds = [fromAgentId, ...recipientIds];
  const agentRows = await query<{ id: string; name: string }>(
    `SELECT id, name FROM agents WHERE id = ANY($1::uuid[]) AND is_active = true`,
    [allIds],
  );
  const nameMap = new Map(agentRows.map((a) => [a.id, a.name]));
  const fromName = nameMap.get(fromAgentId) ?? '';

  // ── 3. Publish to each recipient ──────────────────────────────────────────
  const timestamp  = new Date().toISOString();
  const msgType    = messageTypeFor(updateType);
  let deliveredCount = 0;
  let failedCount    = 0;

  for (const recipientId of recipientIds) {
    const recipientName = nameMap.get(recipientId) ?? '';
    const speakMessage  = generateSpeakMessage(updateType, fromName, recipientName, metadata);

    const message: BroadcastMessage = {
      type:        msgType,
      fromAgentId,
      payload:     { updateType, summary, metadata },
      speakMessage,
      timestamp,
    };

    try {
      await broadcastToAgent(recipientId, message);
      deliveredCount++;
    } catch (err: unknown) {
      failedCount++;
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.log(
        JSON.stringify({
          level: 'error',
          message: 'Failed to broadcast to recipient',
          agentId: fromAgentId,
          recipientAgentId: recipientId,
          updateType,
          error: errorMessage,
          timestamp,
        }),
      );
    }
  }

  console.log(
    JSON.stringify({
      level: 'info',
      message: 'Broadcast complete',
      agentId: fromAgentId,
      updateType,
      deliveredCount,
      failedCount,
      timestamp,
    }),
  );

  return { deliveredCount, failedCount };
}
