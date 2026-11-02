-- agent-bus schema. Idempotent: safe to re-run against an existing D1 database.

CREATE TABLE IF NOT EXISTS agents (
  name         TEXT PRIMARY KEY,
  role         TEXT NOT NULL DEFAULT '',
  -- 'claude' | 'grok' | 'agent'. Drives the grok-all / claude-any groups.
  kind         TEXT NOT NULL DEFAULT 'agent',
  token_hash   TEXT NOT NULL UNIQUE,
  wake_url     TEXT,
  wake_key     TEXT,
  last_wake_at INTEGER,
  disabled     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL,
  -- Always the authenticated token owner. Never a client-supplied value.
  from_agent   TEXT NOT NULL,
  to_agent     TEXT NOT NULL,
  -- What the sender asked for ('grok-all', a name, ...) before group expansion.
  to_spec      TEXT NOT NULL,
  subject      TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'note',
  needs_reply  INTEGER NOT NULL DEFAULT 0,
  in_reply_to  TEXT,
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER,
  acked_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(to_agent, delivered_at, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_recent ON messages(to_agent, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS wake_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent      TEXT NOT NULL,
  message_id TEXT NOT NULL,
  status     INTEGER,
  error      TEXT,
  at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wake_log_agent ON wake_log(agent, at);

-- Fixed-window request counter, one row per agent per minute.
CREATE TABLE IF NOT EXISTS rate (
  agent TEXT NOT NULL,
  win   INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (agent, win)
);
