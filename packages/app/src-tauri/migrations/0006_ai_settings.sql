CREATE TABLE IF NOT EXISTS ai_settings (
    id                  INTEGER PRIMARY KEY CHECK (id = 1),
    default_provider    TEXT,
    claude_cli_model    TEXT,
    codex_cli_model     TEXT,
    anthropic_api_model TEXT,
    openai_api_model    TEXT,
    updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_connection_overrides (
    connection_id BLOB PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
    provider_id   TEXT NOT NULL,
    model         TEXT
);

INSERT OR IGNORE INTO ai_settings (id, updated_at) VALUES (1, datetime('now'));
