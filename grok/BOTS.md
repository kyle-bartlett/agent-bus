# Per-bot records

No tokens, URLs or keys in this file. The one shared token lives in the laptop Keychain under
service `agent-bus`, account `grok-main`. Wake webhook URLs and keys live only on the bus, which
never returns them to a caller.

Roster seen in the Grok Bot app on 2026-11-02. The list ran past the fold, so the Directors group is
incomplete here.

| Bot | Group | Role as shown | Bus identity | Connector | Routine |
|---|---|---|---|---|---|
| Grok Bot | The Big Honcho | Main, coordinator | grok-main | Added, proven by real tool calls | `Agent bus wake` asked for in chat 14:21 CT, values never arrived, `wake: false` |
| Agent Systems | The Coders Team | | via grok-main | Account-wide | none planned |
| CI & DevOps | The Coders Team | | via grok-main | Account-wide | none planned |
| Feature Build | The Coders Team | | via grok-main | Account-wide | none planned |
| Review & QA | The Coders Team | | via grok-main | Account-wide | none planned |
| Signal | Directors | Consulting pipeline and X intel | via grok-main | Account-wide | `Email relay to Kyle's Claude ag...` paused, leave paused |
| Publishing | Directors | | via grok-main | Account-wide | none planned |
| The Coder | Directors | | via grok-main | Account-wide | none planned |
| Others below the fold | Directors | about 8 directors in total | via grok-main | Account-wide | none planned |

Teams run roughly five bots per director, so the fleet is somewhere near forty bots. None of them
needs its own identity while the main bot dispatches.

## Known from the bots themselves

- The main bot reported on 2026-11-02 that the connector works account-wide, that `agents()`
  returned `claude`, `cos`, `grok-main` and the two smoke identities, and that it passed the Agent
  bus standing rule into its leadership room so the directors have it.
- The Coder was the first director to use the bus in anger. It routed a read-only Turso schema
  question to `cos` through the main bot and is holding a deploy until it hears back.
- The main bot's own note on the gap: nothing wakes it, so replies only surface when it reads its
  inbox. That is exactly what the wake routine fixes.

## When a bot does need its own identity

Only when something on the Claude side has to address it directly rather than through the main bot.
Then:

```sh
cd ~/wildcard/agent-bus
bun run scripts/mint.ts grok-<name> --kind grok --role "<one line>"
```

The token goes to the laptop Keychain. Add a wake webhook only if that bot also needs to be woken,
and never leave two relay routines enabled on the same bot.

## Department heads, named by the main bot on 2026-11-02

The main bot asked for one identity per department and named nine: **The Coder, Signal, Prospecting,
Pumpville, Publishing, Studio, Products, Scout, Finance.** That is the first real list of director
names from the bots themselves rather than from a screenshot, and it is wider than the three visible
above the fold in the app.

None of them is minted. The blocker is not cost, it is whether a single bot can own a custom MCP
server that only it sees. A token has to live in a connector entry, so if every bot shares one
connector, nine tokens have nowhere to go. That question is out with the main bot in
`msg_MAtsLpjz3Fi0hwuS`. See the correction section in `SETUP.md`.

Worth knowing either way: a shared identity does not lose mail. `inbox(unread_only: false)` returns
everything regardless of who marked it delivered, and only the reading bot can set acked.
