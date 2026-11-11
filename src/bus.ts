import type { Agent } from "./auth";
import type { D1PreparedStatement, Env, ExecutionContext } from "./d1";
import { BusError } from "./errors";
import { newId } from "./ids";
import { fireWakes, scheduleWakes, wakeHolds, type WakeHold, type WakeTarget } from "./wake";

export const MAX_BODY_BYTES = 32 * 1024;
export const MAX_SUBJECT_BYTES = 512;
export const MAX_KIND_BYTES = 32;
export const MAX_INBOX_LIMIT = 100;
export const DEFAULT_INBOX_LIMIT = 25;

/** Group aliases accepted in `to`. */
export const GROUPS = ["grok-all", "grok-any", "claude-all", "claude-any"] as const;

export interface MessageRow {
  id: string;
  thread_id: string;
  from_agent: string;
  to_agent: string;
  to_spec: string;
  subject: string;
  body: string;
  kind: string;
  needs_reply: number;
  in_reply_to: string | null;
  created_at: number;
  delivered_at: number | null;
  acked_at: number | null;
}

export interface MessageView {
  id: string;
  thread_id: string;
  from: string;
  to: string;
  to_spec: string;
  subject: string;
  body: string;
  kind: string;
  needs_reply: boolean;
  in_reply_to: string | null;
  created_at: string;
  delivered: boolean;
  acked: boolean;
}

const MESSAGE_COLUMNS = `id, thread_id, from_agent, to_agent, to_spec, subject, body, kind,
  needs_reply, in_reply_to, created_at, delivered_at, acked_at`;

export function view(row: MessageRow): MessageView {
  return {
    id: row.id,
    thread_id: row.thread_id,
    from: row.from_agent,
    to: row.to_agent,
    to_spec: row.to_spec,
    subject: row.subject,
    body: row.body,
    kind: row.kind,
    needs_reply: !!row.needs_reply,
    in_reply_to: row.in_reply_to,
    created_at: new Date(row.created_at).toISOString(),
    delivered: row.delivered_at !== null,
    acked: row.acked_at !== null,
  };
}

function bytes(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BusError(400, "invalid_params", `${field} must be a non-empty string`);
  }
  return value;
}

function checkSize(value: string, field: string, max: number): string {
  if (bytes(value) > max) {
    throw new BusError(413, "too_large", `${field} exceeds ${max} bytes`);
  }
  return value;
}

export function clampLimit(limit: unknown): number {
  const n = typeof limit === "number" ? limit : Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INBOX_LIMIT;
  return Math.min(Math.floor(n), MAX_INBOX_LIMIT);
}

/** Expands `to` into concrete, enabled recipients. The caller is never a recipient of its own send. */
export async function resolveRecipients(env: Env, caller: string, to: string): Promise<WakeTarget[]> {
  const spec = to.trim().toLowerCase();

  const pickKind = async (kind: string, all: boolean): Promise<WakeTarget[]> => {
    if (all) {
      const res = await env.DB.prepare(
        `SELECT name, wake_url, wake_key FROM agents
           WHERE kind = ? AND disabled = 0 AND name != ? ORDER BY name`,
      )
        .bind(kind, caller)
        .all<WakeTarget>();
      return res.results;
    }
    // Least-loaded identity of that kind, so `*-any` spreads work instead of
    // always hammering the first name alphabetically.
    const res = await env.DB.prepare(
      `SELECT a.name AS name, a.wake_url AS wake_url, a.wake_key AS wake_key
         FROM agents a
         LEFT JOIN messages m ON m.to_agent = a.name AND m.delivered_at IS NULL
        WHERE a.kind = ? AND a.disabled = 0 AND a.name != ?
        GROUP BY a.name
        ORDER BY COUNT(m.id) ASC, a.name ASC
        LIMIT 1`,
    )
      .bind(kind, caller)
      .all<WakeTarget>();
    return res.results;
  };

  let targets: WakeTarget[];
  switch (spec) {
    case "grok-all":
      targets = await pickKind("grok", true);
      break;
    case "grok-any":
      targets = await pickKind("grok", false);
      break;
    case "claude-all":
      targets = await pickKind("claude", true);
      break;
    case "claude-any":
      targets = await pickKind("claude", false);
      break;
    default: {
      const row = await env.DB.prepare(
        `SELECT name, wake_url, wake_key, disabled FROM agents WHERE name = ?`,
      )
        .bind(spec)
        .first<WakeTarget & { disabled: number }>();
      if (!row) throw new BusError(404, "unknown_recipient", `No identity or group named '${to}'`);
      if (row.disabled) throw new BusError(409, "recipient_disabled", `Identity ${row.name} is disabled`);
      targets = [{ name: row.name, wake_url: row.wake_url, wake_key: row.wake_key }];
    }
  }

  if (targets.length === 0) {
    throw new BusError(404, "no_recipients", `'${to}' resolved to nobody reachable`);
  }
  return targets;
}

async function threadHasMember(env: Env, threadId: string, agent: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM messages
       WHERE thread_id = ? AND (from_agent = ? OR to_agent = ?) LIMIT 1`,
  )
    .bind(threadId, agent, agent)
    .first<{ ok: number }>();
  return !!row;
}

async function threadExists(env: Env, threadId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS ok FROM messages WHERE thread_id = ? LIMIT 1`)
    .bind(threadId)
    .first<{ ok: number }>();
  return !!row;
}

export interface SendInput {
  to: unknown;
  subject?: unknown;
  body: unknown;
  thread_id?: unknown;
  needs_reply?: unknown;
  kind?: unknown;
}

export interface SendResult {
  thread_id: string;
  delivered_to: string[];
  message_ids: string[];
  woke: string[];
  /** Present only when a webhook target was not woken: the message is stored and waits for its next wake. */
  wake_held?: WakeHold[];
}

export async function send(
  env: Env,
  ctx: ExecutionContext | undefined,
  caller: Agent,
  input: SendInput,
  opts: { inReplyTo?: string | null; awaitWakes?: boolean } = {},
): Promise<SendResult> {
  const to = requireString(input.to, "to");
  const body = checkSize(requireString(input.body, "body"), "body", MAX_BODY_BYTES);
  const subject = checkSize(
    typeof input.subject === "string" ? input.subject : "",
    "subject",
    MAX_SUBJECT_BYTES,
  );
  const kind = checkSize(
    typeof input.kind === "string" && input.kind.trim() ? input.kind.trim() : "note",
    "kind",
    MAX_KIND_BYTES,
  );
  const needsReply = input.needs_reply === true || input.needs_reply === 1 || input.needs_reply === "true";

  let threadId: string;
  if (typeof input.thread_id === "string" && input.thread_id.trim()) {
    threadId = input.thread_id.trim();
    // Reusing an existing thread id requires having been in it. Stops an
    // identity from injecting messages into a conversation it never joined.
    if ((await threadExists(env, threadId)) && !(await threadHasMember(env, threadId, caller.name))) {
      throw new BusError(403, "not_in_thread", `${caller.name} is not a participant in ${threadId}`);
    }
  } else {
    threadId = newId("thr");
  }

  const targets = await resolveRecipients(env, caller.name, to);
  const now = Date.now();
  const ids = targets.map(() => newId("msg"));

  const statements: D1PreparedStatement[] = targets.map((target, i) =>
    env.DB.prepare(
      `INSERT INTO messages
         (id, thread_id, from_agent, to_agent, to_spec, subject, body, kind, needs_reply, in_reply_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      ids[i],
      threadId,
      caller.name, // authenticated identity, never anything from the request body
      target.name,
      to,
      subject,
      body,
      kind,
      needsReply ? 1 : 0,
      opts.inReplyTo ?? null,
      now,
    ),
  );
  await env.DB.batch(statements);

  const payloadFor = (agentName: string) => {
    const idx = targets.findIndex((t) => t.name === agentName);
    return { message_id: ids[idx]!, thread_id: threadId, from: caller.name, subject };
  };

  const held = await wakeHolds(env, targets, kind);
  const wakeable = targets.filter((t) => !held.some((h) => h.agent === t.name));

  const wakeWork = fireWakes(env, wakeable, payloadFor);
  if (opts.awaitWakes) await wakeWork;
  else scheduleWakes(ctx, wakeWork);

  return {
    thread_id: threadId,
    delivered_to: targets.map((t) => t.name),
    message_ids: ids,
    woke: wakeable.filter((t) => t.wake_url).map((t) => t.name),
    ...(held.length > 0 ? { wake_held: held } : {}),
  };
}

async function markDelivered(env: Env, agent: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const res = await env.DB.prepare(
    `UPDATE messages SET delivered_at = ?
       WHERE to_agent = ? AND delivered_at IS NULL AND id IN (${placeholders})`,
  )
    .bind(Date.now(), agent, ...ids)
    .run();
  return res.meta.changes;
}

export async function inbox(
  env: Env,
  caller: Agent,
  opts: { unreadOnly?: boolean; limit?: unknown; mark?: boolean } = {},
): Promise<{ agent: string; count: number; messages: MessageView[] }> {
  const limit = clampLimit(opts.limit);
  const unreadOnly = opts.unreadOnly !== false;
  const where = unreadOnly ? "to_agent = ? AND delivered_at IS NULL" : "to_agent = ?";

  const res = await env.DB.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  )
    .bind(caller.name, limit)
    .all<MessageRow>();

  const rows = res.results.slice().reverse(); // oldest first reads like a conversation
  if (opts.mark) await markDelivered(env, caller.name, rows.map((r) => r.id));

  return { agent: caller.name, count: rows.length, messages: rows.map(view) };
}

export async function thread(
  env: Env,
  caller: Agent,
  threadId: unknown,
  opts: { mark?: boolean } = {},
): Promise<{ thread_id: string; count: number; messages: MessageView[] }> {
  const id = requireString(threadId, "thread_id").trim();
  if (!(await threadHasMember(env, id, caller.name))) {
    throw new BusError(404, "thread_not_found", `No thread ${id} visible to ${caller.name}`);
  }

  const res = await env.DB.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC`,
  )
    .bind(id)
    .all<MessageRow>();

  const mine = res.results.filter((r) => r.to_agent === caller.name).map((r) => r.id);
  if (opts.mark !== false) await markDelivered(env, caller.name, mine);

  return { thread_id: id, count: res.results.length, messages: res.results.map(view) };
}

export async function reply(
  env: Env,
  ctx: ExecutionContext | undefined,
  caller: Agent,
  input: { thread_id: unknown; body: unknown; kind?: unknown },
  opts: { awaitWakes?: boolean } = {},
): Promise<SendResult> {
  const threadId = requireString(input.thread_id, "thread_id").trim();
  if (!(await threadHasMember(env, threadId, caller.name))) {
    throw new BusError(404, "thread_not_found", `No thread ${threadId} visible to ${caller.name}`);
  }

  const last = await env.DB.prepare(
    `SELECT id, from_agent, subject FROM messages
       WHERE thread_id = ? AND from_agent != ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  )
    .bind(threadId, caller.name)
    .first<{ id: string; from_agent: string; subject: string }>();

  if (!last) {
    throw new BusError(409, "no_reply_target", `Nobody else has posted in ${threadId} yet`);
  }

  const subject = last.subject.startsWith("Re: ") ? last.subject : `Re: ${last.subject}`;
  return send(
    env,
    ctx,
    caller,
    {
      to: last.from_agent,
      subject: subject.slice(0, 480),
      body: input.body,
      thread_id: threadId,
      kind: typeof input.kind === "string" && input.kind.trim() ? input.kind : "reply",
    },
    { inReplyTo: last.id, awaitWakes: opts.awaitWakes },
  );
}

export async function ack(
  env: Env,
  caller: Agent,
  messageId: unknown,
): Promise<{ message_id: string; acked: true }> {
  const id = requireString(messageId, "message_id").trim();
  const now = Date.now();
  const res = await env.DB.prepare(
    `UPDATE messages
        SET acked_at = ?, delivered_at = COALESCE(delivered_at, ?)
      WHERE id = ? AND to_agent = ?`,
  )
    .bind(now, now, id, caller.name)
    .run();

  if (res.meta.changes === 0) {
    throw new BusError(404, "message_not_found", `No message ${id} addressed to ${caller.name}`);
  }
  return { message_id: id, acked: true };
}

export async function agents(
  env: Env,
): Promise<{ groups: string[]; agents: { name: string; role: string; kind: string; wake: boolean }[] }> {
  const res = await env.DB.prepare(
    `SELECT name, role, kind, wake_url FROM agents WHERE disabled = 0 ORDER BY name`,
  ).all<{ name: string; role: string; kind: string; wake_url: string | null }>();

  return {
    groups: [...GROUPS],
    // wake_url / wake_key are never exposed: they are inbound credentials.
    agents: res.results.map((r) => ({ name: r.name, role: r.role, kind: r.kind, wake: !!r.wake_url })),
  };
}

export async function markDeliveredIds(
  env: Env,
  caller: Agent,
  ids: unknown,
): Promise<{ marked: number }> {
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== "string")) {
    throw new BusError(400, "invalid_params", "message_ids must be an array of strings");
  }
  if (ids.length > MAX_INBOX_LIMIT) {
    throw new BusError(400, "invalid_params", `At most ${MAX_INBOX_LIMIT} ids per call`);
  }
  return { marked: await markDelivered(env, caller.name, ids as string[]) };
}
