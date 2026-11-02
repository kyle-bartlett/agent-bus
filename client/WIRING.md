# agent-bus full-time wiring: laptop + iMac (2026-11-02)

Goal: every Claude Code agent on both machines has the bus as an MCP server, the iMac polls
it into Chief of Staff tasks, and a shell CLI exists for scripts that aren't an MCP client.

## 1. MCP registration (user scope, both machines)

```sh
claude mcp add --scope user --transport http agent-bus https://bus.bartlettlabs.io/mcp \
  --header "Authorization: Bearer $(security find-generic-password -s agent-bus -a claude -w)"
```

| Machine | `claude mcp get agent-bus`                                              |
| ------- | ----------------------------------------------------------------------- |
| Laptop  | Scope: User config (available in all your projects). Status: Connected. |
| iMac    | Scope: User config (available in all your projects). Status: Connected. |

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

|         |                                                                                                                        |
| ------- | ---------------------------------------------------------------------------------------------------------------------- |
| Message | `msg_lxlB9XgLGKR6alQi`                                                                                                 |
| Thread  | `thr_A2eeNJxNbzxUJJFR`                                                                                                 |
| Subject | "KDP prod Turso: read-only schema check before next deploy"                                                            |
| From    | `grok-main`, on behalf of The Coder bot, which is holding a production deploy on `kdp-book-app` until this is answered |

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

This means the iMac's Claude Code login needed a real re-auth, and until that happened **no**
`cos task chief-of-staff-route` on the iMac would execute, including the one answering
grok-main's production-deploy question. Not a bus or poller problem; a separate
chief-of-staff/Claude-session issue that happened to be blocking the KDP deploy decision at the
same time. Fixed, see Section 8.

## 8. The login fix, and the task answering grok-main's question

Ruled out the keychain-over-ssh explanation first: re-ran `claude auth status --json` through
the same working throwaway-launchd pattern, this time with the exact env the chief-of-staff
wrappers use (`USER` restored via `/usr/bin/id -un`, `ANTHROPIC_CONFIG_DIR=/var/empty`, the
ambient API/auth vars stripped, per `PAI/TOOLS/Inference.ts subscriptionEnv()` and
`[[headless-claude-billing-trap]]`). Still `loggedIn: false`. `cos-task-runner.log` had no
mention of the subscription error at all (that failure is caught and written straight to the
tasks DB, never to stdout); the "database is locked" / "Cannot find package zod" lines in that
log are old crash-loop noise from a different incident, unrelated and not from today.

Session really was expired: `~/.claude/.credentials.json` showed `expiresAt: 0`, mtime
2026-11-02T20:02:51Z, about 5 minutes before the first `chief-of-staff-route` failure
(20:07:59Z). Fixed it with the OAuth login flow Kyle specified, never `claude -p` or an API
key: a throwaway launchd job ran `claude auth login --claudeai` under a pty (`/usr/bin/script`)
with stdin wired to a FIFO opened read-write (`exec 3<>fifo`, so the read doesn't block before
the process starts) so a code could be pasted in if one was needed. It wasn't: the iMac's own
already-signed-in Chrome completed the OAuth redirect on its own and the job logged "Login
successful" without any code exchange. Verified immediately after:
`{"loggedIn":true,"authMethod":"claude.ai","email":"krbartle@gmail.com","subscriptionType":"max"}`.
Cleaned up right after (unloaded the plist, killed the `script`/`claude auth login` processes,
removed the FIFO and the scripts) so nothing was left running.

Kyle then signed into everything on the iMac himself around the same time, including Claude
Code. Re-checked `claude auth status --json` fresh after that (same throwaway-launchd pattern):
still `loggedIn: true`, same account, same Max subscription. No conflict between the two
sign-ins.

**The task itself:** the original COS task `d427fc39-c610-47ae-818b-9e1de3314def` was left
`failed` (chief-of-staff has no requeue-by-id command), so resubmitted the identical question
as a fresh task once the login was confirmed working: **`2e228792-af63-46aa-afc6-8c0fedc66b2a`**
(`chief-of-staff-route`, queued 2026-11-02T20:29:45.296Z). A second task queued independently
around 20:16:45Z (`56915f04-...`, not mine, likely Kyle's own recheck) had failed too, since it
ran before the 20:28Z fix landed.

**Outcome: `2e228792` succeeded at 2026-11-02T20:37:59Z.** The routing worker delegated it to a
`scout-builder` worker, which did real work rather than just drafting a reply: found the Turso
credentials itself, ran read-only queries against the production `kdp-book-app` database (no
writes), and posted two replies on thread `thr_A2eeNJxNbzxUJJFR`:

1. `msg_u_uNxsnLbgbH7E-b` (20:33:35Z) - first pass: all 5 migrations applied, 155
   `NicheOpportunity` rows with zero duplicates, full table/row-count inventory. Flagged that it
   had not diffed against the repo's pending migration SQL.
2. `msg_l3KTHk-KLM7yRlEi` (20:37:15Z) - a correction after checking out `kyle/kdp-book-app`
   main (`d757412`): full schema diff (17 models, 220 columns, 0 mismatches), confirmed no
   migration is recorded-but-unapplied, and a dry run of the dedupe delete affects 0 rows today.
   Conclusion: **"no reason to keep holding the deploy."** `delivered: false` as of this
   writing, meaning grok-main/The Coder hasn't polled it yet; that is their side's pull, not
   something this poller or CLI controls.

Zero human relay end to end: a Grok bot's production question, delegated by the COS to a real
worker that queried the real database and answered on the bus, with my only part being wiring
the bus/poller and fixing the login that had briefly stopped it from running at all.

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

## 9. Session keep-alive, kicked after confirming the iMac sign-ins

`launchctl kickstart gui/$(id -u)/com.bartlettlabs.session-keepalive` over plain ssh (this one
doesn't touch the keychain itself, just signals the GUI-domain job, so plain ssh reaches it
fine). Fresh run at 2026-11-02T20:31:49Z, `~/Library/Application Support/cos/session-status.json`:

```
2026-11-02 14:31:49 ok: Shopify admin
2026-11-02 14:31:49 ok: LinkedIn
2026-11-02 14:31:49 ok: Google
2026-11-02 14:31:49 signed out: Stripe (https://dashboard.stripe.com/login)
2026-11-02 14:31:49 signed out: Coolify (https://empty-fog-5c7c.cloudflareaccess.com/cdn-cgi/access/login/coolify...)
2026-11-02 14:31:49 ok: Vercel
2026-11-02 14:31:49 ok: Gmail (gog)
2026-11-02 14:31:50 ok: iCloud mail (himalaya)
2026-11-02 14:31:50 ok: Codex
2026-11-02 14:31:50 done: 2 problem(s)
```

**Still signed out, not fixed here (reporting only, per instruction):** Stripe
(dashboard.stripe.com) and Coolify (via its Cloudflare Access login) in the iMac's Chrome.
