#!/usr/bin/env bun
/**
 * End-to-end smoke test against the DEPLOYED agent-bus.
 *
 *   bun run scripts/smoke.ts
 *
 * Base URL from AGENT_BUS_URL or Keychain agent-bus/_base_url. Test identities
 * smoke-a and smoke-b are reused from the Keychain when their tokens still
 * work, and minted with the admin token when they do not.
 *
 * Prints "SMOKE: PASS" and exits 0, or the failing step and exits non-zero.
 */
import { adminToken, api, baseUrl, keychainGet, keychainSet, mcpTool } from "./keychain";

const base = baseUrl();
const steps: string[] = [];

function check(label: string, ok: boolean, detail?: unknown): void {
  if (!ok) throw new Error(`${label}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  steps.push(label);
  console.log(`  ok  ${label}`);
}

/** Reuses a stored token when it still authenticates; mints a fresh one otherwise. */
async function identity(name: string, kind: string, role: string): Promise<string> {
  const stored = keychainGet(name);
  if (stored) {
    const who = await api<{ name: string }>("/v1/whoami", { token: stored, base });
    if (who.status === 200 && who.body.name === name) return stored;
  }

  const res = await api<{ token: string; error?: string; message?: string }>("/v1/admin/agents", {
    method: "POST",
    token: adminToken(),
    base,
    body: { name, kind, role, rotate: true },
  });
  if (res.status !== 201) {
    throw new Error(`could not mint ${name} (HTTP ${res.status}): ${res.body.error} ${res.body.message}`);
  }
  keychainSet(name, res.body.token);
  return res.body.token;
}

interface MessageView {
  id: string;
  thread_id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  acked: boolean;
}

const started = Date.now();
console.log(`agent-bus smoke against ${base}`);

try {
  const health = await api<{ ok: boolean; name: string; mcp: string }>("/health", { base });
  check("health responds", health.status === 200 && health.body.name === "agent-bus", health.body);
  check("health advertises the MCP endpoint", health.body.mcp === `${base}/mcp`, health.body.mcp);

  const a = await identity("smoke-a", "agent", "smoke test sender");
  const b = await identity("smoke-b", "agent", "smoke test receiver");
  check("two test identities authenticate", a !== b && a.length > 20);

  const unauthorized = await api("/v1/inbox", { base });
  check("no token is rejected", unauthorized.status === 401, unauthorized.status);

  const init = await api<{ result: { serverInfo: { name: string }; protocolVersion: string } }>("/mcp", {
    method: "POST",
    token: a,
    base,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } },
    },
  });
  check("MCP initialize handshake", init.body.result?.serverInfo?.name === "agent-bus", init.body);

  const tools = await api<{ result: { tools: { name: string }[] } }>("/mcp", {
    method: "POST",
    token: a,
    base,
    body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
  });
  const toolNames = (tools.body.result?.tools ?? []).map((t) => t.name).sort();
  check(
    "MCP tools/list exposes all seven tools",
    ["ack", "agents", "ask_and_wait", "inbox", "reply", "send", "thread"].every((t) =>
      toolNames.includes(t),
    ),
    toolNames,
  );

  const agentList = await mcpTool<{ agents: { name: string }[]; groups: string[] }>(a, "agents", {}, base);
  const names = agentList.agents.map((x) => x.name);
  check(
    "agents() lists both test identities",
    names.includes("smoke-a") && names.includes("smoke-b"),
    names,
  );
  check("agents() lists the group aliases", agentList.groups.includes("grok-all"), agentList.groups);

  const stamp = new Date().toISOString();
  const sent = await api<{ thread_id: string; delivered_to: string[]; message_ids: string[] }>("/v1/send", {
    method: "POST",
    token: a,
    base,
    body: { to: "smoke-b", subject: `smoke ${stamp}`, body: `hello from smoke-a at ${stamp}`, needs_reply: true },
  });
  check("REST send is accepted", sent.status === 201 && sent.body.delivered_to[0] === "smoke-b", sent.body);

  const spoof = await api<{ thread_id: string }>("/v1/send", {
    method: "POST",
    token: a,
    base,
    body: { to: "smoke-b", subject: "spoof attempt", body: "from should be ignored", from: "cos" },
  });
  const spoofThread = await mcpTool<{ messages: MessageView[] }>(
    b,
    "thread",
    { thread_id: spoof.body.thread_id },
    base,
  );
  check(
    "a client-supplied 'from' is ignored",
    spoofThread.messages.every((m) => m.from === "smoke-a"),
    spoofThread.messages.map((m) => m.from),
  );

  const inbox = await mcpTool<{ messages: MessageView[] }>(b, "inbox", { limit: 50 }, base);
  const mine = inbox.messages.find((m) => m.thread_id === sent.body.thread_id);
  check("MCP inbox returns the message verbatim", mine?.body === `hello from smoke-a at ${stamp}`, mine);

  const replied = await mcpTool<{ delivered_to: string[] }>(
    b,
    "reply",
    { thread_id: sent.body.thread_id, body: `ack from smoke-b at ${stamp}` },
    base,
  );
  check("MCP reply routes back to the sender", replied.delivered_to[0] === "smoke-a", replied);

  const thread = await mcpTool<{ count: number; messages: MessageView[] }>(
    a,
    "thread",
    { thread_id: sent.body.thread_id },
    base,
  );
  check("thread shows both sides in order", thread.count === 2, thread.messages.map((m) => m.from));
  check(
    "thread preserves the reply body",
    thread.messages[1]?.body === `ack from smoke-b at ${stamp}`,
    thread.messages[1]?.body,
  );

  const replyId = thread.messages[1]!.id;
  const acked = await mcpTool<{ acked: boolean }>(a, "ack", { message_id: replyId }, base);
  check("ack marks the reply handled", acked.acked === true, acked);

  // ask_and_wait: smoke-b answers while smoke-a is holding the request open.
  const asking = mcpTool<{ status: string; answer?: MessageView; waited_s: number }>(
    a,
    "ask_and_wait",
    { to: "smoke-b", question: `round trip ${stamp}?`, timeout_s: 45 },
    base,
  );

  const answering = (async () => {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const pending = await api<{ messages: MessageView[] }>("/v1/inbox?unread_only=1&limit=20", {
        token: b,
        base,
      });
      const question = pending.body.messages?.find((m) => m.body === `round trip ${stamp}?`);
      if (question) {
        await api("/v1/reply", {
          method: "POST",
          token: b,
          base,
          body: { thread_id: question.thread_id, body: `answered ${stamp}` },
        });
        return question.id;
      }
    }
    throw new Error("smoke-b never saw the ask_and_wait question");
  })();

  const [asked, questionId] = await Promise.all([asking, answering]);
  check("ask_and_wait returned an answer", asked.status === "answered", asked);
  check("ask_and_wait answer body is intact", asked.answer?.body === `answered ${stamp}`, asked.answer);
  check("ask_and_wait returned before its timeout", asked.waited_s < 45, asked.waited_s);

  const delivered = await api<{ marked: number }>("/v1/delivered", {
    method: "POST",
    token: b,
    base,
    body: { message_ids: [questionId] },
  });
  check("REST delivered endpoint is callable", delivered.status === 200, delivered.body);

  const oversize = await api<{ error: string }>("/v1/send", {
    method: "POST",
    token: a,
    base,
    body: { to: "smoke-b", body: "x".repeat(33 * 1024) },
  });
  check("an oversized body is refused", oversize.status === 413, oversize.status);

  console.log(`\nSMOKE: PASS (${steps.length} checks in ${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.error(`\n  FAIL ${e instanceof Error ? e.message : String(e)}`);
  console.error(`SMOKE: FAIL after ${steps.length} passing checks`);
  process.exit(1);
}
