#!/usr/bin/env bun
/**
 * Create an agent-bus identity (or rotate its token) and store the token in the
 * macOS Keychain under service `agent-bus`, account = agent name.
 *
 *   bun run scripts/mint.ts cos --kind claude --role "Chief of staff"
 *   bun run scripts/mint.ts grok-main --kind grok --role "Grok Bot" \
 *     --wake-url https://hook.example.com/wake --wake-key "$SECRET"
 *   bun run scripts/mint.ts grok-main --rotate
 */
import { adminToken, api, baseUrl, keychainSet } from "./keychain";

interface Args {
  name?: string;
  role?: string;
  kind?: string;
  wakeUrl?: string;
  wakeKey?: string;
  rotate: boolean;
  print: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { rotate: false, print: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "--role": args.role = next(); break;
      case "--kind": args.kind = next(); break;
      case "--wake-url": args.wakeUrl = next(); break;
      case "--wake-key": args.wakeKey = next(); break;
      case "--rotate": args.rotate = true; break;
      case "--print": args.print = true; break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown flag ${arg}`);
        args.name = arg;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.name) {
  console.error("usage: bun run scripts/mint.ts <name> [--kind claude|grok|agent] [--role \"...\"]");
  console.error("                                [--wake-url URL] [--wake-key KEY] [--rotate] [--print]");
  process.exit(2);
}

const base = baseUrl();
const admin = adminToken();

const payload: Record<string, unknown> = {
  name: args.name,
  kind: args.kind ?? (args.name.startsWith("grok") ? "grok" : "claude"),
  role: args.role ?? "",
  rotate: args.rotate,
};
if (args.wakeUrl) payload.wake_url = args.wakeUrl;
if (args.wakeKey) payload.wake_key = args.wakeKey;

const { status, body } = await api<{
  name: string;
  kind: string;
  role: string;
  token: string;
  wake: boolean;
  created: boolean;
  error?: string;
  message?: string;
}>("/v1/admin/agents", { method: "POST", token: admin, body: payload, base });

if (status !== 201) {
  console.error(`mint failed (HTTP ${status}): ${body.error ?? ""} ${body.message ?? ""}`.trim());
  if (body.error === "already_exists") console.error("Pass --rotate to issue a new token for it.");
  process.exit(1);
}

keychainSet(body.name, body.token);

console.log(`${body.created ? "Created" : "Rotated"} ${body.name} (${body.kind})`);
if (body.role) console.log(`  role: ${body.role}`);
console.log(`  wake webhook: ${body.wake ? "set" : "none (pull-based)"}`);
console.log(`  token saved to Keychain: service agent-bus, account ${body.name}`);
console.log(`  read it back: security find-generic-password -s agent-bus -a ${body.name} -w`);

// Shown once. The server only ever stored a SHA-256 hash of it.
if (args.print) console.log(`\n${body.token}`);
else console.log("\n(pass --print to echo the token to stdout)");

console.log(`\nClaude Code:  claude mcp add --transport http agent-bus ${base}/mcp \\`);
console.log(`                --header "Authorization: Bearer $(security find-generic-password -s agent-bus -a ${body.name} -w)"`);
console.log(`Grok Bot:     Remote HTTPS MCP -> ${base}/mcp with that bearer token`);
