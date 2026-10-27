import type {
  EventPayload,
  ContextUpdate,
  ActiveTask,
  Blocker,
  Decision,
  HandoffPayload,
} from '@scottie/shared';

// ── Parse error ───────────────────────────────────────────────────────────────

/**
 * Thrown when a required field is missing or carries an invalid value.
 * The worker catches this, logs it internally, and sends the event to the
 * dead-letter queue after max retries — it never reaches an HTTP response.
 */
export class ParseError extends Error {
  constructor(
    public readonly eventType: string,
    public readonly reason: string,
  ) {
    super(`parseEvent failed for "${eventType}": ${reason}`);
    this.name = 'ParseError';
  }
}

// ── Safe extraction helpers ───────────────────────────────────────────────────

/** Returns v if it is a string; otherwise returns fallback. */
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** Returns v if it is a non-empty string; otherwise returns null. */
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Returns v if it is a non-empty string.
 * Throws ParseError when the field is absent or empty — use for fields
 * whose absence would produce a broken or unroutable update.
 */
function requireStr(v: unknown, field: string, eventType: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ParseError(eventType, `missing required field "${field}"`);
  }
  return v;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const VALID_AVAILABILITY = ['available', 'busy', 'offline', 'heads_down'] as const;
type Availability = (typeof VALID_AVAILABILITY)[number];

// ── Main parser ───────────────────────────────────────────────────────────────

/**
 * Converts an EventPayload into a ContextUpdate.
 *
 * Pure transformation — no I/O, no database, no Redis, no Express dependency.
 * Async signature matches the worker's await call site; no internal awaits.
 *
 * Throws ParseError for two categories of payload problem:
 *   - Missing required field  (e.g. handoff.initiated without toAgentId)
 *   - Invalid enum value      (e.g. availability.changed with unknown string)
 *
 * Non-critical fields (titles, refs) fall back to safe defaults rather than
 * failing so that cosmetic gaps in external payloads do not block processing.
 */
export async function parseEvent(event: EventPayload): Promise<ContextUpdate> {
  const { source, eventType, targetAgentId, rawPayload } = event;

  const base = {
    targetAgentId,
    updateType: eventType,
    broadcastTo: [] as string[],
    metadata: rawPayload,
  };

  switch (eventType) {
    // ── GitHub / Jira task assignment ──────────────────────────────────────────
    case 'pr.assigned':
    case 'issue.assigned': {
      const title = str(rawPayload.prTitle ?? rawPayload.issueSummary, 'Untitled');
      const ref   = strOrNull(rawPayload.prUrl ?? rawPayload.issueKey);
      const task: ActiveTask = {
        id: crypto.randomUUID(),
        title,
        ref,
        status: 'assigned',
        assignedAt: new Date().toISOString(),
        source,
      };
      return {
        ...base,
        patch: {
          activeTasks: [task],
          currentStatus: `Working on: ${title}`,
        },
      };
    }

    // ── Pull request lifecycle ─────────────────────────────────────────────────
    case 'pr.review_requested': {
      const prTitle = str(rawPayload.prTitle, 'a PR');
      return { ...base, patch: { currentStatus: `Review requested: ${prTitle}` } };
    }

    case 'pr.merged': {
      const prTitle = str(rawPayload.prTitle, 'a PR');
      return { ...base, patch: { currentStatus: `Merged: ${prTitle}` } };
    }

    case 'pr.closed': {
      const prTitle = str(rawPayload.prTitle, 'a PR');
      return { ...base, patch: { currentStatus: `Closed without merging: ${prTitle}` } };
    }

    // ── Issue lifecycle ────────────────────────────────────────────────────────
    case 'issue.status_changed': {
      const summary = str(rawPayload.issueSummary, 'An issue');
      const status  = str(rawPayload.issueStatus, 'updated');
      return { ...base, patch: { currentStatus: `${summary}: ${status}` } };
    }

    // ── Handoffs ───────────────────────────────────────────────────────────────
    case 'handoff.initiated': {
      // Critical: without toAgentId the update has no broadcast target.
      const toAgentId = requireStr(rawPayload.toAgentId, 'toAgentId', eventType);
      return {
        ...base,
        patch: {
          // Trust the sender to have constructed a valid HandoffPayload.
          pendingHandoff: (rawPayload.handoffPayload as HandoffPayload) ?? null,
        },
        broadcastTo: [toAgentId],
      };
    }

    case 'handoff.acknowledged': {
      const taskRef = str(rawPayload.taskRef, 'a task');
      return { ...base, patch: { currentStatus: `Handoff acknowledged: ${taskRef}` } };
    }

    // ── Status ─────────────────────────────────────────────────────────────────
    case 'status.updated': {
      const statusMessage = str(rawPayload.statusMessage);
      return {
        ...base,
        patch: { currentStatus: statusMessage.length > 0 ? statusMessage : null },
      };
    }

    // ── Blockers ───────────────────────────────────────────────────────────────
    case 'blocker.added': {
      const description = str(
        rawPayload.blockerDescription ?? rawPayload.description,
        'Unspecified blocker',
      );
      const blocker: Blocker = {
        id: crypto.randomUUID(),
        description,
        taskRef: strOrNull(rawPayload.taskRef),
        reportedAt: new Date().toISOString(),
        resolvedAt: null,
      };
      return { ...base, patch: { blockers: [blocker] } };
    }

    case 'blocker.resolved': {
      const description = str(
        rawPayload.blockerDescription ?? rawPayload.description,
        'a blocker',
      );
      return { ...base, patch: { currentStatus: `Blocker resolved: ${description}` } };
    }

    // ── Task completion ────────────────────────────────────────────────────────
    case 'task.completed': {
      const ref = str(
        rawPayload.taskRef ?? rawPayload.prTitle ?? rawPayload.issueTitle,
        'a task',
      );
      return { ...base, patch: { currentStatus: `Completed: ${ref}` } };
    }

    // ── Availability ───────────────────────────────────────────────────────────
    case 'availability.changed': {
      // Critical: an unrecognised value would write invalid data to the context object.
      const raw = rawPayload.availability;
      if (
        typeof raw !== 'string' ||
        !(VALID_AVAILABILITY as readonly string[]).includes(raw)
      ) {
        throw new ParseError(
          eventType,
          `invalid availability value: "${String(raw)}" — expected one of: ${VALID_AVAILABILITY.join(', ')}`,
        );
      }
      return { ...base, patch: { availability: raw as Availability } };
    }

    // ── Decisions ──────────────────────────────────────────────────────────────
    case 'decision.captured': {
      const description = str(
        rawPayload.decision ?? rawPayload.description,
        'Undocumented decision',
      );
      const decision: Decision = {
        id: crypto.randomUUID(),
        description,
        taskRef: strOrNull(rawPayload.taskRef),
        madeAt: new Date().toISOString(),
        madeBy: str(rawPayload.madeBy, 'unknown'),
      };
      return { ...base, patch: { recentDecisions: [decision] } };
    }

    // ── Exhaustiveness guard ───────────────────────────────────────────────────
    // If a new EventType is added to @scottie/shared but not handled above,
    // TypeScript will report a type error here (EventType is not assignable to never).
    default: {
      const _exhaustive: never = eventType;
      void _exhaustive;
      return { ...base, patch: {} };
    }
  }
}
