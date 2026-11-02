# agent-bus full-time wiring: laptop + iMac (2026-11-02)

Goal: every Claude Code agent on both machines has the bus as an MCP server, the iMac polls
it into Chief of Staff tasks, and a shell CLI exists for scripts that aren't an MCP client.

## 1. MCP registration (user scope, both machines)

```sh
claude mcp add --scope user --transport http agent-bus https://bus.bartlettlabs.io/mcp \
  --header "Authorization: Bearer $(security find-generic-password -s agent-bus -a claude -w)"
```

| Machine | `claude mcp get agent-bus` |
|---|---|
| Laptop | Scope: User config (available in all your projects). Status: Connected. |
| iMac | Scope: User config (available in all your projects). Status: Connected. |

A stale **local**-scope `agent-bus` entry in `~/wildcard/agent-bus` from the earlier bus-build
session was removed (`claude mcp remove agent-bus -s local`) so the user-scope entry is the
only one and applies to every project on the laptop, not just that one repo.

## 2. iMac keychain: tokens for `cos` and `claude`

Plain `ssh imac security find-generic-password ...` fails with "User interaction is not
allowed" because an ssh session has no bound login-keychain security session. Writing (and
later reading, for the poller and the CLI) only works through a `launchd` job, which runs in
the user's real session. Used a throwaway one-shot plist carrying the token values as
`EnvironmentVariables`, loaded it, confirmed the write in a log, then `launchctl unload` and
deleted the plist (secrets never left on disk). Confirmed with a second throwaway job that
reads them back:

```
cos token len:    47
claude token len: 47
base url: https://bus.bartlettlabs.io
```

Also added `_base_url` to the iMac keychain for parity with the laptop.

## 3. iMac poller: `~/grok-bridge/agent-bus-poll.py`

launchd job `com.bartlettlabs.agent-bus`, `StartInterval` 20s, `RunAtLoad` true, logs to
`~/Library/Logs/agent-bus.log`. Polls `GET /v1/inbox?unread_only=0` for identities `cos` and
`claude`, dedupes against its own state file (`~/grok-bridge/agent-bus-state.json`) rather
than the bus's `delivered`/`acked` flags (another reader can mark delivered without the
message being handled), queues one `cos task chief-of-staff-route` per new message through
the bundled bun runtime (same invocation as `~/grok-bridge/agent-report-poll.py`, so it never
touches a bare `claude -p` call and never bills the API key), then marks it delivered on the
bus only after the task is confirmed queued.

**Gotcha found and fixed:** Cloudflare's bot-fight rule (error 1010) blocked Python's default
`urllib` User-Agent string with a 403 on every GET. Fixed by sending a real `User-Agent`
header (`agent-bus-poll/1 (bartlettlabs.io)`). The CLI (`bus.ts`) sends the same header.

`launchctl asuser <uid> security ...` was tried first as a shortcut for the keychain problem
and failed ("Could not switch to audit session... Operation not permitted"); the throwaway
plist is the approach that actually works, same principle Section 2 used.

## 4. Live message, picked up for real

`grok-main` had already sent a real, unprompted question to `cos` before this poller existed:

| | |
|---|---|
| Message | `msg_lxlB9XgLGKR6alQi` |
| Thread | `thr_A2eeNJxNbzxUJJFR` |
| Subject | "KDP prod Turso: read-only schema check before next deploy" |
| From | `grok-main`, on behalf of The Coder bot, which is holding a production deploy on `kdp-book-app` until this is answered |

The poller's first real run (not a manual trigger after the first attempt was blocked by the
403 above) picked it up and queued:

**COS task id: `d427fc39-c610-47ae-818b-9e1de3314def`** (`chief-of-staff-route`, created
2026-11-02T20:07:59.168Z), containing the question body verbatim, the thread id, who asked,
and the reply command to close the loop on the bus. I did not answer the question myself;
answering a production database question is not the bus-wiring task.

Exactly one task was queued for it. The state file (`agent-bus-state.json`) was seeded with
the id of the earlier handshake message (`msg_ocnzw9T41iiVYMjU`, already acked, `needs_reply`
false) so the poller's first run didn't re-queue something already closed.

A second, synthetic smoke message (`bus send --as claude --to cos ...`) confirmed the launchd
job keeps working unattended on its own 20s interval, not just when manually kicked: it
queued **COS task `6518d46a-d982-43af-b6b0-2e045f0fe59d`** on its own, with no duplicate on
the next cycle.

## 5. Blocker found, outside this task's scope: COS task execution is currently broken

Both of those COS tasks, and several unrelated ones (`meeting-watch`, `inbox-applications`,
`inbox-file`) in the same window, show `status: failed`, `error: "Routing stopped: Claude
subscription could not be verified"`. Traced it:

- It isn't the keychain-over-ssh problem from Section 2: `claude auth status --json`, run
  through the same working throwaway-launchd pattern (so a real session, not plain ssh),
  still reports `loggedIn: false`.
- `claude --version` and `claude mcp list` both work fine on the iMac right now, so the CLI
  itself runs; `claude auth status` is a separate check that is failing.
- `~/.claude/.credentials.json` on the iMac has `expiresAt: 0` (access token expired); the
  refresh token itself isn't expired until 2026-11-14.

This means the iMac's Claude Code login needs a real re-auth (`claude /login` from an actual
interactive session), and until that happens **no** `cos task chief-of-staff-route` on the
iMac will execute, including the one answering grok-main's production-deploy question. This
is a pre-existing chief-of-staff/Claude-session issue, not something in `agent-bus`'s scope to
fix, and not something safe to try to patch headlessly (no bare `claude -p`, and OAuth login
needs a browser). Flagging it because it is currently the thing actually blocking the KDP
deploy decision, not the bus or the poller.

## 6. CLI: `client/bus.ts` + `client/bus`

TypeScript over `fetch`, run through whichever `bun` is found (shell `PATH`, then
`~/.local/share/barts-runtime/bun`, then `~/.bun/bin/bun`) by the `bus` wrapper script, same
bun-discovery pattern as the existing `cos` CLI wrapper. Token comes from Keychain via
`--as <identity>` (default `claude`), never from argv or env.

```
bus send --to <name> --body "..." [--subject] [--thread] [--needs-reply] [--kind] [--as identity]
bus inbox [--all] [--limit N] [--as identity]
bus thread <thread_id> [--as identity]
bus reply --thread <id> --body "..." [--as identity]
bus ack <message_id> [--as identity]
bus ask --to <name> --question "..." [--wait] [--timeout N] [--as identity]
bus agents
bus whoami [--as identity]
```

Installed as `~/.local/bin/bus` (laptop, symlink to `~/wildcard/agent-bus/client/bus`) and
`~/.local/bin/bus` (iMac, symlink to `~/agent-bus/client/bus`, files copied there since the
iMac has no git checkout of the `agent-bus` repo). Verified on both:

```
$ bus agents          # laptop, lists claude/cos/grok-main/smoke-a/smoke-b
$ bus whoami --as cos # iMac, via a throwaway launchd job (plain ssh can't reach the keychain) -> {"name":"cos",...}
```

## 7. CLAUDE.md standing note

Appended an "Agent bus (Grok <-> Claude)" section to `~/.claude/CLAUDE.md` on both the laptop
and the iMac: what the bus is, the identities, when to use `ask_and_wait`/`send` instead of
asking Kyle to relay to Grok, and to answer bus messages addressed to you with `reply`.
