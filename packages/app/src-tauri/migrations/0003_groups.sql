CREATE TABLE IF NOT EXISTS connection_groups (
  id          BLOB PRIMARY KEY,
  name        TEXT NOT NULL,
  sort_order  REAL NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connection_groups_sort
  ON connection_groups (sort_order);

ALTER TABLE connections
  ADD COLUMN group_id BLOB REFERENCES connection_groups(id) ON DELETE SET NULL;

ALTER TABLE connections
  ADD COLUMN sort_order REAL NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_connections_group_sort
  ON connections (group_id, sort_order);

UPDATE connections SET sort_order = ord.rn
  FROM (
    SELECT id, ROW_NUMBER() OVER (ORDER BY name COLLATE NOCASE ASC) AS rn
    FROM connections
  ) AS ord
  WHERE connections.id = ord.id;
