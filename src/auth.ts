import type { Env } from "./d1";
import { BusError } from "./errors";
import { constantTimeEqual, sha256Hex } from "./ids";

export interface Agent {
  name: string;
  role: string;
  kind: string;
  wake_url: string | null;
  wake_key: string | null;
}

const DEFAULT_RATE_LIMIT_PER_MIN = 240;

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

/**
 * Resolves the caller from its bearer token alone. The token *is* the identity:
 * nothing a client sends in a body or query can change who it is.
 */
export async function authenticate(env: Env, req: Request): Promise<Agent> {
  const token = bearerToken(req);
  if (!token) throw new BusError(401, "missing_token", "Authorization: Bearer <token> required");

  const row = await env.DB.prepare(
    `SELECT name, role, kind, wake_url, wake_key, disabled
       FROM agents WHERE token_hash = ?`,
  )
    .bind(await sha256Hex(token))
    .first<Agent & { disabled: number }>();

  if (!row) throw new BusError(401, "bad_token", "Unknown or revoked token");
  if (row.disabled) throw new BusError(403, "agent_disabled", `Identity ${row.name} is disabled`);

  return { name: row.name, role: row.role, kind: row.kind, wake_url: row.wake_url, wake_key: row.wake_key };
}

export function requireAdmin(env: Env, req: Request): void {
  const expected = env.ADMIN_TOKEN;
  if (!expected) throw new BusError(503, "admin_disabled", "ADMIN_TOKEN is not configured");
  const token = bearerToken(req);
  if (!token || !constantTimeEqual(token, expected)) {
    throw new BusError(401, "bad_admin_token", "Admin bearer token required");
  }
}

/** Fixed-window per-identity limiter. Throws 429 once the window is spent. */
export async function enforceRateLimit(env: Env, agent: string): Promise<void> {
  const limit = Number(env.RATE_LIMIT_PER_MIN ?? DEFAULT_RATE_LIMIT_PER_MIN);
  if (!Number.isFinite(limit) || limit <= 0) return;

  const win = Math.floor(Date.now() / 60_000);
  const row = await env.DB.prepare(
    `INSERT INTO rate (agent, win, count) VALUES (?, ?, 1)
       ON CONFLICT(agent, win) DO UPDATE SET count = count + 1
       RETURNING count`,
  )
    .bind(agent, win)
    .first<{ count: number }>();

  if ((row?.count ?? 0) > limit) {
    throw new BusError(429, "rate_limited", `Over ${limit} requests/min for ${agent}`);
  }

  // Opportunistic cleanup; no cron needed for a table this small.
  if (Math.random() < 0.02) {
    await env.DB.prepare(`DELETE FROM rate WHERE win < ?`).bind(win - 5).run();
  }
}
