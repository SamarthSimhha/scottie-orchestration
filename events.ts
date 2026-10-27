import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { query } from '../db/connection';
import { enqueueEvent } from '../queues/eventQueue';

const router = Router();

// ── Validation schema ─────────────────────────────────────────────────────────

const EventPayloadSchema = z.object({
  source: z.enum(['github', 'jira', 'linear', 'voice', 'manual', 'system']),
  eventType: z.string().min(1).max(100),
  targetAgentId: z.string().uuid(),
  // Security: cap serialised size to prevent queue flooding with oversized payloads
  rawPayload: z.record(z.unknown()).refine(
    (obj) => JSON.stringify(obj).length < 50_000,
    { message: 'Payload too large' },
  ),
  receivedAt: z.string().datetime(),
});

// ── POST /events/ingest ───────────────────────────────────────────────────────
// Accepts an event, writes it to events_log, pushes to Redis queue, returns 202.
// globalLimiter is applied to all routes in app.ts — no per-route re-application needed.

router.post(
  '/ingest',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = EventPayloadSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          data: null,
          error: { message: 'Invalid event payload', code: 'VALIDATION_ERROR' },
        });
        return;
      }

      const event = parsed.data;

      // Security: log only safe metadata — never log rawPayload contents
      console.log(
        JSON.stringify({
          level: 'info',
          message: 'Event ingested',
          source: event.source,
          eventType: event.eventType,
          targetAgentId: event.targetAgentId,
          timestamp: new Date().toISOString(),
        }),
      );

      const rows = await query<{ id: string }>(
        `INSERT INTO events_log (source, event_type, target_agent_id, raw_payload, received_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [event.source, event.eventType, event.targetAgentId, event.rawPayload, event.receivedAt],
      );
      const eventLogId = rows[0]?.id;

      await enqueueEvent({ ...event, eventLogId });

      res.status(202).json({ data: { queued: true }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
