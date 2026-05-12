CREATE TABLE IF NOT EXISTS saved_query_folders (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT NULL REFERENCES saved_query_folders(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS saved_queries (
  id                 TEXT PRIMARY KEY,
  folder_id          TEXT NULL REFERENCES saved_query_folders(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  sql                TEXT NOT NULL,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  last_connection_id BLOB NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_folders_parent
  ON saved_query_folders (parent_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_queries_folder
  ON saved_queries (folder_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_queries_name
  ON saved_queries (name COLLATE NOCASE);
