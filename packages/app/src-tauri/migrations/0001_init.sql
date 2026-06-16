CREATE TABLE IF NOT EXISTS connections (
  id           BLOB PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  params_json  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
