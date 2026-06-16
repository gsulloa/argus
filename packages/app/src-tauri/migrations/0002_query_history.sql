CREATE TABLE IF NOT EXISTS query_history (
  id              TEXT PRIMARY KEY,
  connection_id   BLOB NOT NULL,
  connection_name TEXT NOT NULL,
  sql             TEXT NOT NULL,
  origin          TEXT NOT NULL,
  status          TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  duration_ms     INTEGER NOT NULL,
  row_count       INTEGER,
  command_tag     TEXT,
  error_code      TEXT,
  error_message   TEXT
);

CREATE INDEX IF NOT EXISTS idx_query_history_started
  ON query_history (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_query_history_connection
  ON query_history (connection_id, started_at DESC);
