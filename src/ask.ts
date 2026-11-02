import type { Agent } from "./auth";
import { send, view, type MessageRow, type MessageView } from "./bus";
import type { Env, ExecutionContext } from "./d1";
import { BusError } from "./errors";

export const MAX_ASK_TIMEOUT_S = 600;
const DEFAULT_ASK_TIMEOUT_S = 60;
const DEFAULT_POLL_MS = 1500;
const FIRST_POLL_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface AskResult {
  status: "answered" | "timeout";
  thread_id: string;
  asked_to: string[];
  waited_s: number;
  answer?: MessageView;
}

/**
 * Sends a question, then polls the thread for the first reply addressed back to
 * the asker. Polling is the only option available: the replier hits a different
 * Worker isolate, so there is no in-process signal to wait on.
 *
 * debt: a long wait holds the request open and accumulates a little CPU per
 * poll. On the Workers free plan (10 ms CPU/invocation) waits beyond a couple of
 * minutes can be cut short by the runtime. Revisit with a Durable Object if the
 * fleet starts asking for multi-minute waits.
 */
export async function askAndWait(
  env: Env,
  ctx: ExecutionContext | undefined,
  caller: Agent,
  input: { to: unknown; question: unknown; timeout_s?: unknown; subject?: unknown; kind?: unknown },
): Promise<AskResult> {
  const requested = Number(input.timeout_s ?? DEFAULT_ASK_TIMEOUT_S);
  if (input.timeout_s !== undefined && (!Number.isFinite(requested) || requested <= 0)) {
    throw new BusError(400, "invalid_params", "timeout_s must be a positive number");
  }
  const timeoutS = Math.min(Math.max(1, Math.floor(requested)), MAX_ASK_TIMEOUT_S);

  const question = input.question;
  const subject =
    typeof input.subject === "string" && input.subject.trim()
      ? input.subject
      : typeof question === "string"
        ? question.replace(/\s+/g, " ").slice(0, 120)
        : "";

  const sent = await send(
    env,
    ctx,
    caller,
    {
      to: input.to,
      subject,
      body: question,
      needs_reply: true,
      kind: typeof input.kind === "string" && input.kind.trim() ? input.kind : "question",
    },
    { awaitWakes: true }, // the answer can't arrive before the wake does
  );

  const pollMs = Number(env.ASK_POLL_MS ?? DEFAULT_POLL_MS);
  const started = Date.now();
  const deadline = started + timeoutS * 1000;
  let wait = Math.min(FIRST_POLL_MS, pollMs);

  for (;;) {
    await sleep(wait);
    const row = await env.DB.prepare(
      `SELECT id, thread_id, from_agent, to_agent, to_spec, subject, body, kind,
              needs_reply, in_reply_to, created_at, delivered_at, acked_at
         FROM messages
        WHERE thread_id = ? AND to_agent = ? AND created_at >= ?
        ORDER BY created_at ASC, rowid ASC LIMIT 1`,
    )
      .bind(sent.thread_id, caller.name, started)
      .first<MessageRow>();

    if (row) {
      await env.DB.prepare(
        `UPDATE messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL`,
      )
        .bind(Date.now(), row.id)
        .run();
      return {
        status: "answered",
        thread_id: sent.thread_id,
        asked_to: sent.delivered_to,
        waited_s: Math.round((Date.now() - started) / 100) / 10,
        answer: view(row),
      };
    }

    if (Date.now() >= deadline) {
      return {
        status: "timeout",
        thread_id: sent.thread_id,
        asked_to: sent.delivered_to,
        waited_s: Math.round((Date.now() - started) / 100) / 10,
      };
    }
    wait = Math.min(pollMs, Math.max(wait * 2, FIRST_POLL_MS), Math.max(deadline - Date.now(), 25));
  }
}
