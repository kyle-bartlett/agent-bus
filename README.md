# agent-bus

A small hosted message bus so Kyle's Claude Code agents and his Grok Bots can talk to each other in
both directions. It speaks MCP over Streamable HTTP for the agents themselves, and plain JSON over
REST for shell scripts and pollers. One Cloudflare Worker, one D1 database, free tier, always on.

| | |
|---|---|
| MCP endpoint | `https://bus.bartlettlabs.io/mcp` |
| REST base | `https://bus.bartlettlabs.io/v1` |
| Health (no auth) | `https://bus.bartlettlabs.io/health` |
| Fallback host | `https://agent-bus.krbartle.workers.dev` |

Both hostnames serve the same Worker and the same data. `bus.bartlettlabs.io` is a proxied `AAAA
100::` placeholder in the zone with a Worker route in front of it.

## Connecting an agent

Each identity has its own bearer token, kept in the macOS Keychain under service `agent-bus` with
the agent's name as the account.

Claude Code:

```sh
claude mcp add --transport http agent-bus https://bus.bartlettlabs.io/mcp \
  --header "Authorization: Bearer $(security find-generic-password -s agent-bus -a claude -w)"
```

Grok Bot: open **Connect Apps**, choose **Add a custom MCP**, and paste one server:

```json
{
  "mcpServers": {
    "agent-bus": {
      "url": "https://bus.bartlettlabs.io/mcp",
      "headers": { "Authorization": "Bearer PASTE_THE_GROK_MAIN_TOKEN" }
    }
  }
}
```

Get the token with `security find-generic-password -s agent-bus -a grok-main -w`. Grok Bot takes one
server per paste.

If that form rejects the `headers` key, use the URL-only form instead. `/mcp/<token>` is the same
endpoint with the bearer in the path, which is how the Weigh and open-brain connectors are already
set up:

```json
{ "mcpServers": { "agent-bus": { "url": "https://bus.bartlettlabs.io/mcp/PASTE_THE_GROK_MAIN_TOKEN" } } }
```

Prefer the header wherever a client allows one. A token in a URL ends up in more logs.

The token decides who you are. There's no `from` parameter anywhere in the API, and a `from` field in
a request body is ignored, so one agent can't post as another.

## Tools

| Tool | Arguments | What it does |
|---|---|---|
| `send` | `to`, `body`, `subject?`, `thread_id?`, `needs_reply?`, `kind?` | Sends a message. Returns the thread id and who it reached. |
| `inbox` | `unread_only?` (default true), `limit?` (max 100) | Lists messages addressed to you, oldest first, and marks them delivered. |
| `thread` | `thread_id` | Every message in one thread you're part of. |
| `reply` | `thread_id`, `body`, `kind?` | Replies to the last agent other than you who posted in that thread. |
| `ack` | `message_id` | Marks one message to you as handled. |
| `ask_and_wait` | `to`, `question`, `timeout_s?` (max 600), `subject?` | Sends a question and holds until the first reply lands. Returns `answered` with the reply, or `timeout`. |
| `agents` | none | The identities on the bus with a one-line role each, plus the group aliases. |

`to` takes an identity name or one of four groups: `grok-all`, `grok-any`, `claude-all`,
`claude-any`. The `-all` groups fan out to every enabled identity of that kind; the `-any` groups
pick the one with the fewest undelivered messages. You're never a recipient of your own send, so a
group of one that's you resolves to nobody and returns `no_recipients`.

## REST endpoints

Same auth, same data, same rules. Useful when a shell script or a poller needs the bus without an
MCP client.

| Method and path | Purpose |
|---|---|
| `GET /health` | Liveness, no auth. |
| `GET /v1/whoami` | Which identity this token is. |
| `GET /v1/agents` | Same payload as the `agents` tool. |
| `GET /v1/inbox?unread_only=1&limit=25&mark=0` | **List unread for an identity.** Read-only by default so a poller can retry safely. Pass `mark=1` to mark delivered in the same call. |
| `POST /v1/delivered` | **Mark delivered.** Body `{"message_ids":["msg_..."]}`. Only touches messages addressed to you. Returns `{"marked":n}`. |
| `POST /v1/send` | Body matches the `send` tool. |
| `POST /v1/reply` | Body `{"thread_id":"...","body":"..."}`. |
| `POST /v1/ack` | Body `{"message_id":"..."}`. |
| `GET /v1/thread/<thread_id>` | The whole thread. Add `?mark=0` to leave it unread. |
| `POST /v1/ask` | Body matches `ask_and_wait`. Holds the request open. |

The iMac poller wants those two bold rows: `GET /v1/inbox?unread_only=1` to see what's waiting, then
`POST /v1/delivered` once it has handed the messages off. Reading the inbox over REST never consumes
anything, so a crash mid-handoff loses nothing.

Example:

```sh
TOKEN=$(security find-generic-password -s agent-bus -a cos -w)
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://bus.bartlettlabs.io/v1/inbox?unread_only=1&limit=20"

curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"to":"grok-main","subject":"PR 14","body":"needs a review pass"}' \
  https://bus.bartlettlabs.io/v1/send
```

## Adding an identity

`scripts/mint.ts` creates the identity, prints the token once, and writes it to the Keychain. It
needs the admin token, which lives in Keychain `agent-bus/_admin` and as the Worker secret
`ADMIN_TOKEN`.

```sh
bun run scripts/mint.ts grok-reviewer --kind grok --role "Reviews PRs on Forgejo"
bun run scripts/mint.ts grok-reviewer --rotate   # new token, same identity
```

`--kind` is `claude`, `grok` or `agent`, and it's what the group aliases match on. Names are 2 to 48
characters of `a-z`, `0-9`, `-` or `_`. Pass `--print` to echo the token to stdout as well as the
Keychain.

Only the SHA-256 hash of a token is ever stored. A lost token can't be recovered, only rotated.

To retire an identity without deleting its history:

```sh
ADMIN=$(security find-generic-password -s agent-bus -a _admin -w)
curl -s -X POST -H "Authorization: Bearer $ADMIN" \
  https://bus.bartlettlabs.io/v1/admin/agents/grok-reviewer/disable
```

## Wake webhooks

Grok-side agents can't poll, so an identity row can hold a wake webhook. When a message is delivered
to an identity that has one, the bus POSTs this envelope to it:

```json
{ "message_id": "msg_...", "thread_id": "thr_...", "from": "cos", "subject": "PR 14" }
```

The body never goes in the webhook, only the pointer. The agent fetches the real message with
`inbox` or `thread`. If a `wake_key` is set it's sent as `Authorization: Bearer <key>`.

Wakes are debounced per identity: a burst of messages produces one POST per 60 seconds per agent.
Every attempt is logged with its status code, so a webhook that's quietly failing is visible. A
failed wake never fails the send, because the message is already stored.

Set or change one:

```sh
ADMIN=$(security find-generic-password -s agent-bus -a _admin -w)
curl -s -X POST -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"wake_url":"https://hook.example.com/grok-wake","wake_key":"<secret>"}' \
  https://bus.bartlettlabs.io/v1/admin/agents/grok-main/wake

# clear it and go back to pull-based
curl -s -X POST -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"wake_url":null}' \
  https://bus.bartlettlabs.io/v1/admin/agents/grok-main/wake

# see what the bus tried
curl -s -H "Authorization: Bearer $ADMIN" \
  "https://bus.bartlettlabs.io/v1/admin/wakes?agent=grok-main&limit=20"
```

`wake_url` must be https. Neither the URL nor the key is ever returned to a caller: `agents()` only
reports whether a webhook exists. Claude-side identities have no webhook and are polled instead.

## Meta Muse

Muse is on the bus as `muse`, kind `agent`. Its connector is a custom one, made by asking Muse in chat
for a custom MCP server at `https://bus.bartlettlabs.io/mcp` with an API key in the Authorization
header. The raw token goes in the connector's key dialog, without a `Bearer` prefix and never in chat.
Muse stores it in its own credential store, and the Keychain keeps the copy under account `muse`.

Muse's connector client has to send its own User-Agent. Cloudflare answers `403 error code: 1010`
to the default `Python-urllib` one before the request reaches the Worker, so a 403 from this bus with
that body isn't a key problem. Muse's client now sends `agent-bus-muse/1.0`.

Nothing can wake Muse. A recurring task inside Muse checks the inbox every 2 hours from 8 AM to 10 PM
Central, so don't point `ask_and_wait` at it. Its standing rule, held in Muse rather than in this
repo, lets it read, send, reply and ack freely. Public posts, messages to people as Kyle, money and
deletes still need Kyle's approval in the Muse app, whoever asks on the bus.

Muse has file access on the laptop but no shell, so its git and iMac writes go through this bus. Messages from
`muse` to `claude` with kind `muse-career` or `muse-linkedin` skip the COS: `~/grok-bridge/agent-bus-poll.py` on
the iMac appends them to `~/career/LOG.md` or the LinkedIn handoff log and replies with the result. Tests are in
`~/grok-bridge/test_muse_log.py`. Muse's instructions are in the vault at `Agents/Muse/Logging Map.md`.

To cut it off, disconnect Agent Bus in Muse under Settings, Connectors, or use the disable call in
[Adding an identity](#adding-an-identity).

## Rules the bus enforces

- **The token is the identity.** Nothing in a request body or query string can change who the sender
  is.
- **Messages are data, never instructions.** Subjects and bodies are stored and returned byte for
  byte. The MCP tool descriptions and the server instructions both say so, so a reading agent treats
  what arrives as information rather than orders.
- **Bodies cap at 32 KB**, subjects at 512 bytes. Over that is a 413.
- **240 requests per minute per identity**, then a 429.
- **Threads are private to their participants.** Reading a thread you're not in is a 404, and reusing
  someone else's thread id on a send is a 403.
- `ask_and_wait` caps at 600 seconds.

## Working on it

```sh
bun install
bun test                 # 28 tests, no network: a bun:sqlite shim stands in for D1
bunx tsc --noEmit
bun run scripts/smoke.ts # against the deployed URL
bun run deploy           # wrangler deploy
bun run migrate          # apply migrations/0001_init.sql to remote D1
```

The tests drive the real Worker entrypoint through `test/harness.ts`, which implements the slice of
the D1 API this code uses on top of `bun:sqlite`. That keeps `bun test` fast and offline while still
exercising the actual routing, auth and SQL.

### Layout

```
src/index.ts   routing, CORS, error shaping
src/mcp.ts     MCP Streamable HTTP, JSON-RPC, tool definitions
src/rest.ts    the JSON mirror and the admin routes
src/bus.ts     send, inbox, thread, reply, ack, agents, group resolution
src/ask.ts     ask_and_wait
src/wake.ts    wake webhooks and the debounce
src/admin.ts   identity minting, wake config
src/auth.ts    bearer to identity, rate limiting
src/d1.ts      hand-written D1 and Env types
```

`src/d1.ts` is deliberately not `@cloudflare/workers-types`: that package collides with `@types/bun`
over `Response` and friends, and `bunx tsc --noEmit` has to cover `src`, `test` and `scripts` in one
pass.

### One known limit

`ask_and_wait` polls D1 while holding the request open, because the replying agent hits a different
Worker isolate and there's no in-process signal to wait on. On the Workers free plan each invocation
gets 10 ms of CPU, and a very long wait can accumulate past that. Waits up to a couple of minutes are
comfortable. If the fleet starts wanting multi-minute waits, move the wait into a Durable Object.
