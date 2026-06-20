use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::platform::DbState;

/// String-form provider id used at storage and IPC boundaries.
/// The strongly-typed ProviderId enum (and its serde kebab-case impl) lives in
/// the `types` module which is added in Phase 2 — to avoid a cyclic dep this
/// module accepts/produces the kebab-case string and the caller converts.
pub const PROVIDER_CLAUDE_CLI: &str = "claude-cli";
pub const PROVIDER_CODEX_CLI: &str = "codex-cli";
pub const PROVIDER_ANTHROPIC_API: &str = "anthropic-api";
pub const PROVIDER_OPENAI_API: &str = "openai-api";

pub const KNOWN_PROVIDERS: &[&str] = &[
    PROVIDER_CLAUDE_CLI,
    PROVIDER_CODEX_CLI,
    PROVIDER_ANTHROPIC_API,
    PROVIDER_OPENAI_API,
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiSettingsRow {
    pub default_provider: Option<String>,
    pub claude_cli_model: Option<String>,
    pub codex_cli_model: Option<String>,
    pub anthropic_api_model: Option<String>,
    pub openai_api_model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConnectionOverrideRow {
    pub connection_id: String,
    pub provider_id: String,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiSettingsInput {
    pub default_provider: Option<String>,
    pub claude_cli_model: Option<String>,
    pub codex_cli_model: Option<String>,
    pub anthropic_api_model: Option<String>,
    pub openai_api_model: Option<String>,
    pub overrides: Vec<ConnectionOverrideRow>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedProviderConfig {
    pub provider_id: String,
    pub model: Option<String>,
}

pub struct AiSettings;

impl AiSettings {
    /// Read the singleton row plus all overrides.
    pub fn get(db: &DbState) -> AppResult<(AiSettingsRow, Vec<ConnectionOverrideRow>)> {
        let conn =
            db.0.lock()
                .map_err(|_| AppError::Internal("db poisoned".into()))?;

        let row = conn.query_row(
            "SELECT default_provider, claude_cli_model, codex_cli_model, \
             anthropic_api_model, openai_api_model \
             FROM ai_settings WHERE id = 1",
            [],
            |r| {
                Ok(AiSettingsRow {
                    default_provider: r.get(0)?,
                    claude_cli_model: r.get(1)?,
                    codex_cli_model: r.get(2)?,
                    anthropic_api_model: r.get(3)?,
                    openai_api_model: r.get(4)?,
                })
            },
        )?;

        let mut stmt =
            conn.prepare("SELECT connection_id, provider_id, model FROM ai_connection_overrides")?;
        let overrides = stmt
            .query_map([], |r| {
                let id_bytes: Vec<u8> = r.get(0)?;
                let provider_id: String = r.get(1)?;
                let model: Option<String> = r.get(2)?;
                let uuid = Uuid::from_slice(&id_bytes).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Blob,
                        Box::new(e),
                    )
                })?;
                Ok(ConnectionOverrideRow {
                    connection_id: uuid.to_string(),
                    provider_id,
                    model,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        Ok((row, overrides))
    }

    /// Persist input atomically in a transaction.
    /// Validates that `input.default_provider`, when `Some`, is one of `KNOWN_PROVIDERS`.
    /// Validates that each override's `provider_id` is one of `KNOWN_PROVIDERS`.
    /// Replaces all rows in `ai_connection_overrides` with the provided list.
    pub fn set(db: &DbState, input: &AiSettingsInput) -> AppResult<()> {
        if let Some(ref p) = input.default_provider {
            if !KNOWN_PROVIDERS.contains(&p.as_str()) {
                return Err(AppError::Validation(format!("unknown provider: {p}")));
            }
        }
        for ov in &input.overrides {
            if !KNOWN_PROVIDERS.contains(&ov.provider_id.as_str()) {
                return Err(AppError::Validation(format!(
                    "unknown provider in override: {}",
                    ov.provider_id
                )));
            }
        }

        let mut conn =
            db.0.lock()
                .map_err(|_| AppError::Internal("db poisoned".into()))?;

        let tx = conn.transaction()?;
        let now = chrono::Utc::now().to_rfc3339();
        tx.execute(
            "UPDATE ai_settings SET \
             default_provider = ?1, \
             claude_cli_model = ?2, \
             codex_cli_model = ?3, \
             anthropic_api_model = ?4, \
             openai_api_model = ?5, \
             updated_at = ?6 \
             WHERE id = 1",
            params![
                input.default_provider,
                input.claude_cli_model,
                input.codex_cli_model,
                input.anthropic_api_model,
                input.openai_api_model,
                now,
            ],
        )?;

        tx.execute("DELETE FROM ai_connection_overrides", [])?;

        for ov in &input.overrides {
            let id = Uuid::parse_str(&ov.connection_id)
                .map_err(|e| AppError::Validation(format!("invalid connection id: {e}")))?;
            tx.execute(
                "INSERT INTO ai_connection_overrides (connection_id, provider_id, model) \
                 VALUES (?1, ?2, ?3)",
                params![id.as_bytes().to_vec(), ov.provider_id, ov.model],
            )?;
        }

        tx.commit()?;
        Ok(())
    }

    /// Resolve which provider to use for a given connection.
    ///
    /// 1. If `connection_id` is `Some` and a matching override row exists → return that.
    /// 2. Else if `default_provider` is `NULL` → `Err(Validation("no AI provider configured"))`.
    /// 3. Else return the default provider + the matching `<provider>_model` column (may be `None`).
    pub fn resolve(db: &DbState, connection_id: Option<Uuid>) -> AppResult<ResolvedProviderConfig> {
        let conn =
            db.0.lock()
                .map_err(|_| AppError::Internal("db poisoned".into()))?;

        if let Some(uuid) = connection_id {
            let override_row: Option<(String, Option<String>)> = conn
                .query_row(
                    "SELECT provider_id, model FROM ai_connection_overrides \
                     WHERE connection_id = ?1",
                    params![uuid.as_bytes().to_vec()],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;

            if let Some((provider_id, model)) = override_row {
                let model = crate::modules::ai::caps::sanitize_model(&provider_id, model);
                return Ok(ResolvedProviderConfig { provider_id, model });
            }
        }

        let (default_provider, model_col): (Option<String>, Option<String>) = conn.query_row(
            "SELECT default_provider, \
             CASE default_provider \
               WHEN 'claude-cli'      THEN claude_cli_model \
               WHEN 'codex-cli'       THEN codex_cli_model \
               WHEN 'anthropic-api'   THEN anthropic_api_model \
               WHEN 'openai-api'      THEN openai_api_model \
               ELSE NULL \
             END \
             FROM ai_settings WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;

        match default_provider {
            None => Err(AppError::Validation("no AI provider configured".into())),
            Some(provider_id) => Ok(ResolvedProviderConfig {
                provider_id: provider_id.clone(),
                model: crate::modules::ai::caps::sanitize_model(&provider_id, model_col),
            }),
        }
    }
}

fn provider_id_to_column(id: &str) -> Option<&'static str> {
    match id {
        PROVIDER_CLAUDE_CLI => Some("claude_cli_model"),
        PROVIDER_CODEX_CLI => Some("codex_cli_model"),
        PROVIDER_ANTHROPIC_API => Some("anthropic_api_model"),
        PROVIDER_OPENAI_API => Some("openai_api_model"),
        _ => None,
    }
}

// Suppress unused warning — this helper will be used in Phase 2+ when factory
// builds providers by reading the per-provider model column by name.
#[allow(dead_code)]
pub(crate) fn column_for_provider(id: &str) -> Option<&'static str> {
    provider_id_to_column(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::storage::open_in_memory;
    use rusqlite::params;
    use std::sync::Mutex;

    fn make_db() -> DbState {
        let conn = open_in_memory().expect("open in-memory db");
        DbState(Mutex::new(conn))
    }

    fn insert_connection(conn: &rusqlite::Connection, id: &Uuid) {
        conn.execute(
            "INSERT INTO connections (id, name, kind, params_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id.as_bytes().to_vec(), "test-conn", "postgres", "{}", 0_i64,],
        )
        .expect("insert connection");
    }

    #[test]
    fn no_default_no_override_returns_validation_error() {
        let db = make_db();
        let err = AiSettings::resolve(&db, None).unwrap_err();
        assert!(
            matches!(&err, AppError::Validation(msg) if msg == "no AI provider configured"),
            "unexpected error: {err:?}"
        );
    }

    #[test]
    fn default_only_no_connection_id() {
        let db = make_db();
        AiSettings::set(
            &db,
            &AiSettingsInput {
                default_provider: Some("claude-cli".into()),
                claude_cli_model: Some("claude-opus-4-8".into()),
                codex_cli_model: None,
                anthropic_api_model: None,
                openai_api_model: None,
                overrides: vec![],
            },
        )
        .unwrap();

        let resolved = AiSettings::resolve(&db, None).unwrap();
        assert_eq!(resolved.provider_id, "claude-cli");
        assert_eq!(resolved.model.as_deref(), Some("claude-opus-4-8"));
    }

    #[test]
    fn retired_global_model_resolves_to_none() {
        // gpt-4o-mini is retired from openai-api; resolve should return None so provider
        // uses its default (gpt-5.1).
        let db = make_db();
        AiSettings::set(
            &db,
            &AiSettingsInput {
                default_provider: Some("openai-api".into()),
                claude_cli_model: None,
                codex_cli_model: None,
                anthropic_api_model: None,
                openai_api_model: Some("gpt-4o-mini".into()),
                overrides: vec![],
            },
        )
        .unwrap();

        let resolved = AiSettings::resolve(&db, None).unwrap();
        assert_eq!(resolved.provider_id, "openai-api");
        assert_eq!(resolved.model, None, "retired model should resolve to None");
    }

    #[test]
    fn retired_override_model_resolves_to_none() {
        // claude-opus-4-7 is retired from anthropic-api; override should resolve to None.
        let db = make_db();
        let conn_id = Uuid::new_v4();

        {
            let lock = db.0.lock().unwrap();
            insert_connection(&lock, &conn_id);
        }

        AiSettings::set(
            &db,
            &AiSettingsInput {
                default_provider: Some("claude-cli".into()),
                claude_cli_model: None,
                codex_cli_model: None,
                anthropic_api_model: None,
                openai_api_model: None,
                overrides: vec![ConnectionOverrideRow {
                    connection_id: conn_id.to_string(),
                    provider_id: "anthropic-api".into(),
                    model: Some("claude-opus-4-7".into()),
                }],
            },
        )
        .unwrap();

        let resolved = AiSettings::resolve(&db, Some(conn_id)).unwrap();
        assert_eq!(resolved.provider_id, "anthropic-api");
        assert_eq!(
            resolved.model, None,
            "retired override model should resolve to None"
        );
    }

    #[test]
    fn valid_global_model_preserved() {
        // claude-sonnet-4-6 is still valid for anthropic-api; it must be preserved.
        let db = make_db();
        AiSettings::set(
            &db,
            &AiSettingsInput {
                default_provider: Some("anthropic-api".into()),
                claude_cli_model: None,
                codex_cli_model: None,
                anthropic_api_model: Some("claude-sonnet-4-6".into()),
                openai_api_model: None,
                overrides: vec![],
            },
        )
        .unwrap();

        let resolved = AiSettings::resolve(&db, None).unwrap();
        assert_eq!(resolved.provider_id, "anthropic-api");
        assert_eq!(resolved.model.as_deref(), Some("claude-sonnet-4-6"));
    }

    #[test]
    fn override_wins_over_global_default() {
        let db = make_db();
        let conn_id = Uuid::new_v4();

        {
            let lock = db.0.lock().unwrap();
            insert_connection(&lock, &conn_id);
        }

        AiSettings::set(
            &db,
            &AiSettingsInput {
                default_provider: Some("openai-api".into()),
                claude_cli_model: None,
                codex_cli_model: None,
                anthropic_api_model: None,
                openai_api_model: None,
                overrides: vec![ConnectionOverrideRow {
                    connection_id: conn_id.to_string(),
                    provider_id: "claude-cli".into(),
                    model: None,
                }],
            },
        )
        .unwrap();

        let resolved = AiSettings::resolve(&db, Some(conn_id)).unwrap();
        assert_eq!(resolved.provider_id, "claude-cli");
    }

    #[test]
    fn cascade_delete_removes_override() {
        let db = make_db();
        let conn_id = Uuid::new_v4();

        {
            let lock = db.0.lock().unwrap();
            insert_connection(&lock, &conn_id);
        }

        AiSettings::set(
            &db,
            &AiSettingsInput {
                default_provider: Some("openai-api".into()),
                claude_cli_model: None,
                codex_cli_model: None,
                anthropic_api_model: None,
                openai_api_model: None,
                overrides: vec![ConnectionOverrideRow {
                    connection_id: conn_id.to_string(),
                    provider_id: "claude-cli".into(),
                    model: None,
                }],
            },
        )
        .unwrap();

        {
            let lock = db.0.lock().unwrap();
            lock.execute(
                "DELETE FROM connections WHERE id = ?1",
                params![conn_id.as_bytes().to_vec()],
            )
            .expect("delete connection");
        }

        let (_settings, overrides) = AiSettings::get(&db).unwrap();
        assert!(
            overrides.is_empty(),
            "override should have been cascade-deleted"
        );
    }
}
