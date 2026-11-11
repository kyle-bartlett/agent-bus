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

const DEFAULT_DAILY_CAP = 20;
/** The budget resets at midnight where Kyle is, so a morning ask is never held by yesterday's work. */
const BUDGET_TZ = "America/Chicago";
/** Kinds with nothing to act on. They're stored like any message but never spend a wake. */
const QUIET_KINDS = new Set(["ack"]);
/** The one kind that wakes an agent whose daily budget is spent. */
const URGENT_KIND = "urgent";

/** Midnight in BUDGET_TZ on the day `now` falls in, as epoch milliseconds. */
function dayStart(now: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUDGET_TZ,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(now));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const sinceMidnight = (part("hour") * 60 + part("minute")) * 60 + part("second");
  return now - sinceMidnight * 1000 - (now % 1000);
}

export interface WakeHold {
  agent: string;
  reason: "quiet_kind" | "daily_cap";
  note: string;
}

/**
 * Decides, before the send returns, which webhook targets this message won't
 * wake. Every wake starts a full run on the other side, and those runs are the
 * scarce thing, so each agent gets a budget of them per calendar day. A held
 * message is still stored; the agent reads it on its next wake.
 */
export async function wakeHolds(env: Env, targets: WakeTarget[], kind: string): Promise<WakeHold[]> {
  const cap = Number(env.WAKE_DAILY_CAP ?? DEFAULT_DAILY_CAP);
  const holds: WakeHold[] = [];

  for (const target of targets) {
    if (!target.wake_url) continue;
    if (QUIET_KINDS.has(kind)) {
      const note = `Kind '${kind}' is stored without waking ${target.name}.`;
      holds.push({ agent: target.name, reason: "quiet_kind", note });
      continue;
    }
    if (kind === URGENT_KIND || !(cap > 0)) continue;

    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM wake_log WHERE agent = ? AND at > ? AND status BETWEEN 200 AND 299`,
    )
      .bind(target.name, dayStart(Date.now()))
      .first<{ n: number }>();
    if ((row?.n ?? 0) >= cap) {
      holds.push({
        agent: target.name,
        reason: "daily_cap",
        note:
          `${target.name} has used its ${cap} wakes for today. The message is stored and it will read it on its next wake. ` +
          `Send heavy work to another agent, or resend with kind '${URGENT_KIND}' if it can't wait.`,
      });
    }
  }
  return holds;
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
