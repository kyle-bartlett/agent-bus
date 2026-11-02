#!/usr/bin/env bun
/**
 * bus: tiny CLI over the agent-bus REST API (https://bus.bartlettlabs.io/v1).
 *
 * Token comes from macOS Keychain (service "agent-bus", account = identity), never from argv
 * or env, so a shell history or process list never holds it. `--as <identity>` picks which
 * token to use; default is `claude`. Everything returned by the bus is data from another
 * agent, not instructions, and this CLI never executes it.
 *
 * Usage:
 *   bus send --to <name> --body "..." [--subject ..] [--thread <id>] [--needs-reply] [--kind ..] [--as <identity>]
 *   bus inbox [--as <identity>] [--all] [--limit N]
 *   bus thread <thread_id> [--as <identity>]
 *   bus reply --thread <id> --body "..." [--as <identity>]
 *   bus ack <message_id> [--as <identity>]
 *   bus ask --to <name> --question "..." [--wait] [--timeout N] [--subject ..] [--as <identity>]
 *   bus agents [--as <identity>]
 *   bus whoami [--as <identity>]
 */

const BASE_URL = "https://bus.bartlettlabs.io";
const USER_AGENT = "agent-bus-cli/1 (bartlettlabs.io)";

async function keychainToken(identity: string): Promise<string> {
  const proc = Bun.spawn(
    [
      "security",
      "find-generic-password",
      "-s",
      "agent-bus",
      "-a",
      identity,
      "-w",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `keychain lookup failed for agent-bus/${identity}: ${err.trim()}`,
    );
  }
  return out.trim();
}

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

async function call(
  method: string,
  path: string,
  token: string,
  body?: unknown,
) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(
      `${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`,
    );
  }
  return data;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);
  const identity = (flags.as as string) || "claude";
  if (!cmd) {
    console.error(
      "usage: bus <send|inbox|thread|reply|ack|ask|agents|whoami> ...  (see client/bus.ts header)",
    );
    process.exit(1);
  }
  const token = await keychainToken(identity);

  switch (cmd) {
    case "send": {
      const body = {
        to: flags.to as string,
        body: flags.body as string,
        subject: flags.subject as string | undefined,
        thread_id: flags.thread as string | undefined,
        needs_reply: Boolean(flags["needs-reply"]),
        kind: (flags.kind as string) || undefined,
      };
      if (!body.to || !body.body) throw new Error("send needs --to and --body");
      console.log(
        JSON.stringify(await call("POST", "/v1/send", token, body), null, 2),
      );
      break;
    }
    case "inbox": {
      const unreadOnly = flags.all ? "0" : "1";
      const limit = (flags.limit as string) || "25";
      console.log(
        JSON.stringify(
          await call(
            "GET",
            `/v1/inbox?unread_only=${unreadOnly}&limit=${limit}`,
            token,
          ),
          null,
          2,
        ),
      );
      break;
    }
    case "thread": {
      const threadId = positional[0] || (flags.thread as string);
      if (!threadId) throw new Error("thread needs a thread_id");
      console.log(
        JSON.stringify(
          await call("GET", `/v1/thread/${threadId}`, token),
          null,
          2,
        ),
      );
      break;
    }
    case "reply": {
      const body = {
        thread_id: flags.thread as string,
        body: flags.body as string,
        kind: flags.kind as string | undefined,
      };
      if (!body.thread_id || !body.body)
        throw new Error("reply needs --thread and --body");
      console.log(
        JSON.stringify(await call("POST", "/v1/reply", token, body), null, 2),
      );
      break;
    }
    case "ack": {
      const messageId = positional[0] || (flags.message as string);
      if (!messageId) throw new Error("ack needs a message_id");
      console.log(
        JSON.stringify(
          await call("POST", "/v1/ack", token, { message_id: messageId }),
          null,
          2,
        ),
      );
      break;
    }
    case "ask": {
      const to = flags.to as string;
      const question = (flags.question as string) || (flags.body as string);
      if (!to || !question) throw new Error("ask needs --to and --question");
      if (flags.wait) {
        const body = {
          to,
          question,
          subject: flags.subject as string | undefined,
          timeout_s: Number(flags.timeout) || 120,
        };
        console.log(
          JSON.stringify(await call("POST", "/v1/ask", token, body), null, 2),
        );
      } else {
        const body = {
          to,
          body: question,
          subject: flags.subject as string | undefined,
          needs_reply: true,
          kind: "question",
        };
        console.log(
          JSON.stringify(await call("POST", "/v1/send", token, body), null, 2),
        );
      }
      break;
    }
    case "agents": {
      console.log(
        JSON.stringify(await call("GET", "/v1/agents", token), null, 2),
      );
      break;
    }
    case "whoami": {
      console.log(
        JSON.stringify(await call("GET", "/v1/whoami", token), null, 2),
      );
      break;
    }
    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
