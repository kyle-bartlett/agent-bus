import { GROUPS } from "./bus";
import type { Env } from "./d1";
import { BusError } from "./errors";
import { newToken, sha256Hex } from "./ids";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,47}$/;
const KINDS = ["claude", "grok", "agent"];

function validateName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!NAME_RE.test(name)) {
    throw new BusError(400, "invalid_name", "name must be 2-48 chars of a-z, 0-9, '-' or '_'");
  }
  if ((GROUPS as readonly string[]).includes(name)) {
    throw new BusError(400, "reserved_name", `'${name}' is a group alias, not an identity`);
  }
  return name;
}

function validateKind(raw: unknown): string {
  const kind = typeof raw === "string" && raw.trim() ? raw.trim().toLowerCase() : "agent";
  if (!KINDS.includes(kind)) {
    throw new BusError(400, "invalid_kind", `kind must be one of ${KINDS.join(", ")}`);
  }
  return kind;
}

function validateWakeUrl(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string") throw new BusError(400, "invalid_params", "wake_url must be a string");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BusError(400, "invalid_params", "wake_url must be an absolute URL");
  }
  if (url.protocol !== "https:") {
    throw new BusError(400, "invalid_params", "wake_url must be https");
  }
  return url.toString();
}

export interface MintResult {
  name: string;
  role: string;
  kind: string;
  token: string;
  wake: boolean;
  created: boolean;
  rotated: boolean;
}

/** Creates an identity, or rotates an existing one's token. Returns the plaintext token once. */
export async function mintIdentity(env: Env, body: Record<string, unknown>): Promise<MintResult> {
  const name = validateName(body.name);
  const kind = validateKind(body.kind);
  const role = typeof body.role === "string" ? body.role.slice(0, 200) : "";
  const wakeUrl = validateWakeUrl(body.wake_url);
  const wakeKey = typeof body.wake_key === "string" && body.wake_key ? body.wake_key : null;
  const rotate = body.rotate === true;

  const existing = await env.DB.prepare(`SELECT name FROM agents WHERE name = ?`)
    .bind(name)
    .first<{ name: string }>();

  if (existing && !rotate) {
    throw new BusError(409, "already_exists", `${name} already exists; pass rotate: true to issue a new token`);
  }

  const token = newToken();
  const hash = await sha256Hex(token);

  if (existing) {
    await env.DB.prepare(
      `UPDATE agents
          SET token_hash = ?, role = ?, kind = ?,
              wake_url = COALESCE(?, wake_url), wake_key = COALESCE(?, wake_key),
              disabled = 0
        WHERE name = ?`,
    )
      .bind(hash, role, kind, wakeUrl, wakeKey, name)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO agents (name, role, kind, token_hash, wake_url, wake_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(name, role, kind, hash, wakeUrl, wakeKey, Date.now())
      .run();
  }

  const row = await env.DB.prepare(`SELECT wake_url FROM agents WHERE name = ?`)
    .bind(name)
    .first<{ wake_url: string | null }>();

  return { name, role, kind, token, wake: !!row?.wake_url, created: !existing, rotated: !!existing };
}

export async function setWake(
  env: Env,
  name: string,
  body: Record<string, unknown>,
): Promise<{ name: string; wake: boolean }> {
  const target = validateName(name);
  const clear = body.wake_url === null || body.wake_url === "";
  const wakeUrl = clear ? null : validateWakeUrl(body.wake_url);
  if (!clear && !wakeUrl) throw new BusError(400, "invalid_params", "wake_url required");

  const wakeKey = clear ? null : typeof body.wake_key === "string" && body.wake_key ? body.wake_key : null;

  const res = await env.DB.prepare(
    `UPDATE agents SET wake_url = ?, wake_key = ?, last_wake_at = NULL WHERE name = ?`,
  )
    .bind(wakeUrl, wakeKey, target)
    .run();

  if (res.meta.changes === 0) throw new BusError(404, "unknown_agent", `No identity named ${target}`);
  return { name: target, wake: !!wakeUrl };
}

export async function setDisabled(
  env: Env,
  name: string,
  disabled: boolean,
): Promise<{ name: string; disabled: boolean }> {
  const target = validateName(name);
  const res = await env.DB.prepare(`UPDATE agents SET disabled = ? WHERE name = ?`)
    .bind(disabled ? 1 : 0, target)
    .run();
  if (res.meta.changes === 0) throw new BusError(404, "unknown_agent", `No identity named ${target}`);
  return { name: target, disabled };
}

export async function listIdentities(env: Env): Promise<unknown> {
  const res = await env.DB.prepare(
    `SELECT name, role, kind, wake_url IS NOT NULL AS has_wake, wake_key IS NOT NULL AS has_wake_key,
            disabled, created_at, last_wake_at
       FROM agents ORDER BY name`,
  ).all<Record<string, unknown>>();
  return { agents: res.results };
}

export async function listWakes(env: Env, agent: string | null, limit: number): Promise<unknown> {
  const stmt = agent
    ? env.DB.prepare(
        `SELECT * FROM wake_log WHERE agent = ? ORDER BY at DESC, id DESC LIMIT ?`,
      ).bind(agent, limit)
    : env.DB.prepare(`SELECT * FROM wake_log ORDER BY at DESC, id DESC LIMIT ?`).bind(limit);
  const res = await stmt.all<Record<string, unknown>>();
  return { wakes: res.results };
}
