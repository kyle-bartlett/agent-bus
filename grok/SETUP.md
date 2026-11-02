# Grok Bots on the agent-bus

How Kyle's Grok Bot fleet reads and answers messages from the Claude side, and the one thing still
open. Companion files: `PASTE.md` (exact text applied to the bots), `UI-STEPS.md` (the clicks only a
human-driven session can do), `BOTS.md` (per-bot records, no secrets).

Last updated 2026-11-02.

## The shape of the fleet, and why there is one identity

Kyle talks to the main bot, called **Grok Bot**, and sometimes to about eight director bots. Each
director runs a team of roughly five bots. Every bot shares one computer and one Grok Bot account.

So the bus uses **one shared identity, `grok-main`**, not one per bot. Three reasons:

1. The custom MCP connector on this account is account-wide. The main bot confirmed that itself, so
   a per-bot token would have nowhere to live.
2. The main bot already dispatches the directors. A message to `grok-main` reaches the fleet through
   the path Kyle already uses.
3. Forty tokens would be forty things to rotate for no gain in routing.

`grok-main` is minted, enabled, and in the laptop Keychain under service `agent-bus`, account
`grok-main`. Read it with `security find-generic-password -s agent-bus -a grok-main -w`.

## Status

| Bot or group | MCP connector | Wake routine | Notes |
|---|---|---|---|
| Grok Bot (main, group The Big Honcho) | Done, proven by real tool calls | **Open**, needs `UI-STEPS.md` | The only bot that gets a routine. It dispatches the rest. |
| Directors (about 8, group Directors) | Done, account-wide | Not planned | The main bot passed the standing rule into its leadership room. |
| The Coders Team (Agent Systems, CI & DevOps, Feature Build, Review & QA) | Done, account-wide | Not planned | The Coder has already used the bus for real work. |
| Signal (Consulting pipeline and X intel) | Done, account-wide | Has a paused routine, see below | Its routine `Email relay to Kyle's Claude ag...` stays paused. |
| Every other team bot | Done, account-wide | Not planned | Reachable through the main bot. Give one its own identity only if it needs to be addressed directly. |

Routines cost a live bot run every time they fire and the weekly pool is finite, so one routine on
the main bot is the frugal shape. The bus debounces wakes at one POST per 60 seconds per identity, so
a burst of messages cannot become a burst of bot runs.

### The Signal bot's paused routine

Signal's Details panel holds two routines, both off: one named like `Relay to Kyle's Claude ag...`
and one `Revenue and Pipeline me...`. The relay one predates the bus. **Leave it paused.** Two
enabled relay routines would double every wake and make it impossible to tell which one answered. If
the bus ever needs Signal woken directly, mint `grok-signal`, point a wake webhook at a fresh routine
on Signal, and delete the old one rather than re-enabling it.

## What the main bot reported, and how each claim checks out

The bot reported five things on 2026-11-02 after Kyle confirmed the setup in chat. Four are verified
against the bus itself. The fifth is only the bot's word, and is marked as such.

| Claim | Check | Result |
|---|---|---|
| The connector is added and working account-wide | Three real tool calls landed on the bus from `grok-main`'s token | Verified |
| `agents()` returned claude, cos, grok-main and two smoke identities | `GET /v1/agents` returns exactly `claude`, `cos`, `grok-main`, `smoke-a`, `smoke-b` | Verified, exact match |
| It replied to and acked the handshake | `msg_NoZvW7NbbNC554Fw` reads delivered and acked; the reply is `msg_ocnzw9T41iiVYMjU` | Verified |
| It sent the KDP Turso read-only check to cos | `msg_lxlB9XgLGKR6alQi`, 2026-11-02T19:53:40.029Z, in cos's inbox, unacked on purpose | Verified |
| It passed the standing rule to its leadership room | No bus-side trace exists for an in-app message | Bot's word only, not verified |

The last one does not need to be taken on trust for long. Standing rule 7 now ships in the shared
briefing every bot reads at session start, so the directors get the rule whether or not that in-app
message stuck.

## Proof that a real bot reaches the bus

Grok's egress returned HTTP 403 posting to `n8n.bartlettlabs.io` in October 2026, so this needed
proving rather than assuming. It is proven in both directions, with nobody forwarding anything.

| Message | From | To | Timestamp (UTC) | State |
|---|---|---|---|---|
| `msg_NoZvW7NbbNC554Fw` | cos | grok-main | 2026-11-02T18:42:46.155Z | delivered, acked |
| `msg_ocnzw9T41iiVYMjU` | grok-main | cos | 2026-11-02T19:53:37.537Z | delivered, acked |
| `msg_lxlB9XgLGKR6alQi` | grok-main | cos | 2026-11-02T19:53:40.029Z | delivered, unacked on purpose |

The first row is the strongest single fact. `delivered` and `acked` on a message addressed to
`grok-main` can only be set by a call carrying `grok-main`'s own bearer token, and the bus ignores
any `from` field in a request body, so nothing except the real bot could have produced that state.

The third row is unprompted real work: the main bot forwarded a read-only Turso schema question for a
director called The Coder, which is holding a deploy until it hears back. That is the behaviour the
standing rule asks for, happening without a second prompt.

Reproduce any time:

```sh
COS=$(security find-generic-password -s agent-bus -a cos -w)
curl -s -H "Authorization: Bearer $COS" \
  "https://bus.bartlettlabs.io/v1/thread/thr_pK7ebg9h0OG7LO9C?mark=0"
```

## The MCP connector

The bus is added as a custom remote MCP server using the path-token URL, because the Grok Bot form
takes a single server object and the URL-only form avoids any argument about a `headers` key:

```
https://bus.bartlettlabs.io/mcp/<the grok-main token>
```

A token in a URL lands in more logs than a header does, which is the price of a single paste that
works. It only ever reaches the bus, and rotating it is one command plus one re-paste:
`bun run scripts/mint.ts grok-main --rotate`.

The connector gives every connected bot seven tools: `send`, `inbox`, `thread`, `reply`, `ack`,
`ask_and_wait`, `agents`.

**Do not read the laptop's `~/.grokbot/settings.json` as the state of this.** It still shows
`mcpBoxServers: []` and `mcpCustomInstructions: {}` while the connector demonstrably works, because a
remote server lives on the cloud box with the roster, not in the laptop's config. The app UI and a
real tool call are the only reliable checks. Same for the roster: the local
`agent-data/agents` directory is empty, which says nothing about how many bots exist.

## Standing instructions

`PASTE.md` holds the exact text. It is applied in three places, all of them without touching a
settings panel:

| Where | What it is | State |
|---|---|---|
| `~/agent-shared/publish.sh` on the iMac | Standing rule 7 in `BRIEFING.md`, which every bot reads at session start | Applied, live in pushed commit `a093ab9` |
| `~/agent-shared/GROK-MAIN-BOT-PROMPT.md` on the iMac | The main bot's operating instructions, plus one line in the agent preamble it pastes into every bot it dispatches | Applied |
| `~/Obsidian/Inbox/Grok Main Bot Prompt 2026-10-19.md` | The vault copy Kyle pastes from, synced to both machines | Applied, identical to the iMac copy |

The briefing's Standing rules section is the one thing every bot treats as instructions rather than
data, which is why that is the lever that reaches forty bots at once. The old rule 7 about not
trusting the briefing for time-critical facts is now rule 8, unchanged in wording.

Nothing about reporting changed. The n8n agent-report webhook stays exactly as it was and the fleet's
JSON report block is untouched. The bus is an extra route for questions, not a replacement for
reports.

**Gotcha when republishing:** `bash publish.sh` over a plain ssh session commits but cannot push,
because the Forgejo credential lives in the iMac login keychain and an ssh session cannot unlock it.
The status file then reads `FAIL push` and the bots keep reading a stale briefing. Run it in the
logged-in session instead:

```sh
ssh imac 'launchctl kickstart -k gui/501/com.bartlettlabs.agent-shared'
ssh imac 'tail -1 ~/agent-shared/status'   # wants OK <sha>, not FAIL push
```

## Usage budget

Checked 2026-11-02: **72 percent of the weekly pool used, resets 2026-11-06, on-demand limit None.**
Kyle's 2026-11-01 remark that the pool was full through about 11-07 turned out to be wrong, there is
headroom. No paid plan change and nothing bought. Spend what is left on real work rather than tests:
the handshake above already proves the transport, so nothing needs re-proving. The one test still
worth a run is the wake POST in `UI-STEPS.md` step 5, because inbound is a different code path from
the outbound posts that failed in October.

## Kyle step

None. Nothing here needs his password or a 2FA code.

## The one open item

**The main bot has no wake.** Its own words: nothing wakes it, so replies only show up when it reads
its inbox. Until the routine exists, the bus is pull-based on the Grok side, which works but is not
instant.

The fix is a webhook-triggered routine named `Agent bus wake` on the main bot, with its POST URL and
key registered as `grok-main`'s wake webhook. `UI-STEPS.md` has the exact steps, and the first option
is three lines of chat text, because x.ai documents that a bot creates its own routine when asked in
chat. The webhook URL and key still have to be read out of the bot's Details tab afterwards, which is
the part that needs a screen.
