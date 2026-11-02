import type { Env, ExecutionContext } from "./d1";

const DEFAULT_DEBOUNCE_MS = 60_000;
const WAKE_TIMEOUT_MS = 10_000;

export interface WakeTarget {
  name: string;
  wake_url: string | null;
  wake_key: string | null;
}

export interface WakePayload {
  message_id: string;
  thread_id: string;
  from: string;
  subject: string;
}

/**
 * Claims the per-agent debounce slot. Returns true only for the caller that
 * won it; a burst of messages therefore produces one wake per window. The
 * single conditional UPDATE is the lock, so concurrent Worker isolates can't
 * both win.
 */
async function claimWakeSlot(env: Env, agent: string, now: number, debounceMs: number): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE agents SET last_wake_at = ?
       WHERE name = ? AND (last_wake_at IS NULL OR last_wake_at <= ?)`,
  )
    .bind(now, agent, now - debounceMs)
    .run();
  return res.meta.changes === 1;
}

async function postWake(env: Env, target: WakeTarget, payload: WakePayload): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "agent-bus-wake/1",
  };
  if (target.wake_key) headers.authorization = `Bearer ${target.wake_key}`;

  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(target.wake_url!, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
    });
    status = res.status;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  await env.DB.prepare(
    `INSERT INTO wake_log (agent, message_id, status, error, at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(target.name, payload.message_id, status, error, Date.now())
    .run();
}

/**
 * Fires wake webhooks for the targets that have one. Pull-based identities
 * (Claude-side) have no wake_url and are simply skipped.
 */
export async function fireWakes(
  env: Env,
  targets: WakeTarget[],
  payloadFor: (agent: string) => WakePayload,
): Promise<void> {
  const debounceMs = Number(env.WAKE_DEBOUNCE_MS ?? DEFAULT_DEBOUNCE_MS);
  const now = Date.now();

  for (const target of targets) {
    if (!target.wake_url) continue;
    try {
      if (!(await claimWakeSlot(env, target.name, now, debounceMs))) continue;
      await postWake(env, target, payloadFor(target.name));
    } catch {
      // A failed wake must never fail the send; the message is already stored.
    }
  }
}

/** Runs wakes in the background when a real ExecutionContext is available. */
export function scheduleWakes(ctx: ExecutionContext | undefined, work: Promise<void>): void {
  if (ctx?.waitUntil) ctx.waitUntil(work);
  else void work;
}
