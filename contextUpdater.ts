import type {
  ContextUpdate,
  ContextObject,
  ActiveTask,
  Blocker,
  Decision,
  HandoffPayload,
  EventType,
} from '@scottie/shared';
import { withTransaction } from '../db/connection';

// ── Result ────────────────────────────────────────────────────────────────────

/**
 * Returned to the Worker after a successful context update.
 * Recipient resolution and notification construction belong to the Broadcaster —
 * contextUpdater only reports what changed and who the caller specified as targets.
 */
export interface ContextUpdateResult {
  agentId: string;
  teamId: string | null;
  updateType: EventType;
  /** patch.currentStatus — primary human-readable summary for the Broadcaster */
  summary: string | null;
  /** Original event metadata — used by the Broadcaster to construct speakMessage */
  metadata: Record<string, unknown>;
  /** Non-empty only when the ContextUpdate explicitly named targets (e.g. handoff.initiated) */
  explicitBroadcastTargets: string[];
  /** Threads the event through the pipeline for Worker-level audit logging */
  eventLogId?: string;
}

// ── Error ─────────────────────────────────────────────────────────────────────

export class ContextUpdateError extends Error {
  constructor(
    public readonly agentId: string,
    reason: string,
  ) {
    super(`Context update failed for agent "${agentId}": ${reason}`);
    this.name = 'ContextUpdateError';
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_RECENT_DECISIONS = 10;
const MAX_ACTIVE_TASKS     = 50;

// ── DB row shape (only the fields required for merging) ───────────────────────

interface ContextRow {
  teamId: string | null;
  activeTasks: ActiveTask[];
  blockers: Blocker[];
  recentDecisions: Decision[];
  currentStatus: string | null;
  availability: ContextObject['availability'];
  pendingHandoff: HandoffPayload | null;
}

// ── Merge helpers ─────────────────────────────────────────────────────────────

function mergeActiveTasks(
  current: ActiveTask[],
  incoming: ActiveTask[] | undefined,
): ActiveTask[] {
  if (!incoming?.length) return current;
  // Tasks with a non-null ref are deduped — prevents the same PR appearing twice
  // Tasks with ref === null (e.g. voice-sourced tasks) are always appended
  const knownRefs = new Set(
    current.filter((t) => t.ref !== null).map((t) => t.ref as string),
  );
  const novel = incoming.filter(
    (t) => t.ref === null || !knownRefs.has(t.ref as string),
  );
  const merged = [...current, ...novel];
  // Hard cap — drop oldest entries if the list grows unexpectedly large
  return merged.length > MAX_ACTIVE_TASKS
    ? merged.slice(merged.length - MAX_ACTIVE_TASKS)
    : merged;
}

function mergeBlockers(
  current: Blocker[],
  incoming: Blocker[] | undefined,
): Blocker[] {
  if (!incoming?.length) return current;
  // Each blocker carries a UUID assigned by the parser — always append, never dedup
  return [...current, ...incoming];
}

function mergeDecisions(
  current: Decision[],
  incoming: Decision[] | undefined,
): Decision[] {
  if (!incoming?.length) return current;
  const merged = [...current, ...incoming];
  // Keep only the most recent N decisions — prevents unbounded JSONB blob growth
  return merged.length > MAX_RECENT_DECISIONS
    ? merged.slice(merged.length - MAX_RECENT_DECISIONS)
    : merged;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Applies a ContextUpdate to the agent's context_objects row inside a single
 * serialised transaction (SELECT … FOR UPDATE → merge → UPDATE → COMMIT).
 *
 * Single responsibility: transactional persistence of the context patch.
 * Does NOT query team members, does NOT publish to Redis.
 * Returns a ContextUpdateResult that the Worker passes to the Broadcaster.
 */
export async function applyContextUpdate(
  update: ContextUpdate,
  eventLogId?: string,
): Promise<ContextUpdateResult> {
  const { targetAgentId, updateType, patch, broadcastTo, metadata } = update;

  const { teamId } = await withTransaction(async (client) => {
    // ── 1. Lock the row exclusively ────────────────────────────────────────────
    // Serialises concurrent events targeting the same agent.
    // Any parallel transaction that reaches this SELECT FOR UPDATE on the same
    // agent_id will block here until we COMMIT, then read our committed state.
    const result = await client.query<ContextRow>(
      `SELECT
         team_id             AS "teamId",
         active_tasks        AS "activeTasks",
         blockers,
         recent_decisions    AS "recentDecisions",
         current_status      AS "currentStatus",
         availability,
         pending_handoff     AS "pendingHandoff"
       FROM context_objects
       WHERE agent_id = $1
       FOR UPDATE`,
      [targetAgentId],
    );

    if (result.rows.length === 0) {
      throw new ContextUpdateError(
        targetAgentId,
        'context_objects row not found — agent may not be registered',
      );
    }

    const current = result.rows[0];

    // ── 2. Merge patch onto current state ──────────────────────────────────────
    const mergedTasks     = mergeActiveTasks(current.activeTasks    ?? [], patch.activeTasks);
    const mergedBlockers  = mergeBlockers(current.blockers          ?? [], patch.blockers);
    const mergedDecisions = mergeDecisions(current.recentDecisions  ?? [], patch.recentDecisions);

    // Scalars: only override when the key is explicitly present in the patch object.
    // This lets a patch set currentStatus to null (intentional clear) while still
    // distinguishing "not in patch" (keep existing) from "in patch as undefined/null".
    const newStatus = 'currentStatus' in patch
      ? (patch.currentStatus ?? null)
      : current.currentStatus;

    const newAvailability = 'availability' in patch
      ? patch.availability!
      : current.availability;

    const newHandoff = 'pendingHandoff' in patch
      ? (patch.pendingHandoff ?? null)
      : current.pendingHandoff;

    // ── 3. Write merged state — lock held until COMMIT ─────────────────────────
    // pg treats bare JS arrays as PostgreSQL array literals, not JSON.
    // JSON.stringify() + ::jsonb cast ensures the driver sends a JSON string
    // that PostgreSQL parses correctly as a JSONB value.
    await client.query(
      `UPDATE context_objects SET
         active_tasks        = $2::jsonb,
         blockers            = $3::jsonb,
         recent_decisions    = $4::jsonb,
         current_status      = $5,
         availability        = $6,
         pending_handoff     = $7::jsonb,
         last_webhook_update = NOW(),
         updated_at          = NOW()
       WHERE agent_id = $1`,
      [
        targetAgentId,
        JSON.stringify(mergedTasks),
        JSON.stringify(mergedBlockers),
        JSON.stringify(mergedDecisions),
        newStatus,
        newAvailability,
        newHandoff !== null ? JSON.stringify(newHandoff) : null,
      ],
    );

    return { teamId: current.teamId };
  });

  // Security: log only safe metadata — never log context contents or user data
  console.log(
    JSON.stringify({
      level: 'info',
      message: 'Context update applied',
      agentId: targetAgentId,
      updateType,
      ...(eventLogId !== undefined && { eventLogId }),
      timestamp: new Date().toISOString(),
    }),
  );

  return {
    agentId: targetAgentId,
    teamId,
    updateType,
    summary: patch.currentStatus ?? null,
    metadata,
    explicitBroadcastTargets: broadcastTo,
    ...(eventLogId !== undefined && { eventLogId }),
  };
}
