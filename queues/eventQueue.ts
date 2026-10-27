import Redis from 'ioredis';

// ── Queue / channel names ─────────────────────────────────────────────────────

const PENDING_QUEUE = 'events:pending';
const DEAD_LETTER_QUEUE = 'events:dead_letter';

// ── Connection factory ────────────────────────────────────────────────────────
// Every connection gets an error handler so ioredis 'error' events never
// propagate to Node's uncaughtException handler and crash the process.

function createClient(purpose: string): Redis {
  if (!process.env.REDIS_URL) {
    console.log(
      JSON.stringify({
        level: 'warn',
        message: 'REDIS_URL is not set — falling back to redis://localhost:6379',
        purpose,
      }),
    );
  }

  const client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

  client.on('error', (err: Error) => {
    console.log(
      JSON.stringify({
        level: 'error',
        message: 'Redis connection error',
        purpose,
        error: err.message,
      }),
    );
  });

  return client;
}

// ── Connections ───────────────────────────────────────────────────────────────
// Two persistent clients are required at module level:
//   redis     — issues all commands (RPUSH, BLPOP, etc.)
//   publisher — PUBLISH only; a connection in SUBSCRIBE mode cannot issue commands
//
// Each subscribeToChannel() call creates a third, dedicated subscriber client.
// All are tracked in `subscribers` for clean shutdown.

const redis = createClient('commands');
const publisher = createClient('publisher');
const subscribers: Redis[] = [];

// ── Queue operations ──────────────────────────────────────────────────────────

export async function enqueueEvent(event: Record<string, unknown>): Promise<void> {
  await redis.rpush(PENDING_QUEUE, JSON.stringify(event));
}

/**
 * Blocks for up to 5 seconds waiting for the next event.
 * Returns null on timeout so the caller can loop without spinning.
 */
export async function dequeueEvent(): Promise<Record<string, unknown> | null> {
  const result = await redis.blpop(PENDING_QUEUE, 5);
  if (!result) return null;
  return JSON.parse(result[1]) as Record<string, unknown>;
}

export async function sendToDeadLetter(event: Record<string, unknown>): Promise<void> {
  await redis.rpush(
    DEAD_LETTER_QUEUE,
    JSON.stringify({ ...event, dead_lettered_at: new Date().toISOString() }),
  );
}

// ── Pub/Sub ───────────────────────────────────────────────────────────────────

export async function publishToChannel(
  channel: string,
  message: Record<string, unknown>,
): Promise<void> {
  await publisher.publish(channel, JSON.stringify(message));
}

/**
 * Subscribes to a Redis channel. Each call creates a dedicated connection
 * (required: a SUBSCRIBE connection cannot issue other commands).
 * The connection is registered for cleanup via closeAllConnections().
 */
export async function subscribeToChannel(
  channel: string,
  handler: (message: Record<string, unknown>) => void,
): Promise<void> {
  const subscriber = createClient(`subscriber:${channel}`);
  subscribers.push(subscriber);

  await subscriber.subscribe(channel);

  subscriber.on('message', (ch: string, raw: string) => {
    if (ch !== channel) return;
    try {
      handler(JSON.parse(raw) as Record<string, unknown>);
    } catch (err: any) {
      console.log(
        JSON.stringify({
          level: 'error',
          message: 'Failed to parse pub/sub message',
          channel,
          error: err.message,
        }),
      );
    }
  });
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

/**
 * Closes every Redis connection this module owns.
 * Call on SIGTERM / afterAll in tests to prevent open-handle warnings.
 */
export async function closeAllConnections(): Promise<void> {
  await Promise.all([
    redis.quit(),
    publisher.quit(),
    ...subscribers.map((s) => s.quit()),
  ]);
}

export default redis;
