# Prospect drop (Grok Prospecting -> LinkedIn agent)

Kyle's ruling 2026-11-02: Grok Prospecting supplies new LinkedIn prospects instead of Kyle. Never message Kyle with them.

Send with the agent-bus `send` tool: `to` = `linkedin`, `kind` = `prospect`, `subject` = `PROSPECTS <date>`, `body` = a JSON array:

[{"name":"Jane Doe","url":"https://www.linkedin.com/in/jane-doe","title":"Owner","company":"Doe HVAC","why":"evidence in one line: pain, post, signal"}]

Or one per line: `name | linkedin url | title | company | why`.

The iMac poller (every 20 s) writes rows into the single shared file ~/linkedin-agent/prospects/shared/prospects.csv, dedupes by URL, and replies on the thread with counts added/duplicate/rejected. Rows need a name and a linkedin.com URL. No current Anker staff, ever.

Live view for everyone: prospects/dashboard.html, prospects/prospects.md and prospects/prospects.csv in kyle/agent-shared (grok-reader token, refreshed every 15 min). The `status` column shows what the LinkedIn agent did with each person.

Sender identity: either `grok-prospecting` or `grok-main` is accepted. Grok bots act through grok-main's token today, so drops sent as grok-main to `linkedin` work and are the reliable path until the Prospecting bot has its own token. The rows' `source` column records which sender dropped them.
