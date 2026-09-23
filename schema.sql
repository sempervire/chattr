CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  incarnation TEXT NOT NULL,
  pid INTEGER,
  pid_start TEXT,
  tty TEXT,
  surface TEXT NOT NULL DEFAULT 'unknown',
  cwd TEXT,
  repo TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  last_seen INTEGER NOT NULL,
  last_wake_at INTEGER,
  wake_endpoint TEXT,
  joined_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  uuid TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_spec TEXT NOT NULL,
  repo TEXT,
  type TEXT NOT NULL CHECK (type IN ('msg', 'consult', 'reply', 'broadcast')),
  reply_to TEXT REFERENCES messages(uuid),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  superseded_by TEXT,
  reply_status TEXT CHECK (reply_status IN ('answered', 'interrupted', 'unknown'))
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  incarnation TEXT NOT NULL,
  event TEXT NOT NULL,
  continued INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  acked_at INTEGER
);

CREATE TABLE IF NOT EXISTS deliveries (
  message_uuid TEXT NOT NULL REFERENCES messages(uuid),
  session_id TEXT NOT NULL,
  incarnation TEXT,
  batch INTEGER REFERENCES batches(id),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_injected_at INTEGER,
  acked_at INTEGER,
  stale_at INTEGER,
  PRIMARY KEY (message_uuid, session_id)
);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  resource TEXT NOT NULL,
  session_id TEXT NOT NULL,
  incarnation TEXT NOT NULL,
  note TEXT,
  claimed_at INTEGER NOT NULL,
  released_at INTEGER,
  release_reason TEXT CHECK (release_reason IN ('released', 'owner_gone'))
);

CREATE UNIQUE INDEX IF NOT EXISTS claims_active ON claims (repo, resource) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries (session_id, acked_at);
CREATE INDEX IF NOT EXISTS messages_order ON messages (created_at, uuid);
