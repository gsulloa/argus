use std::time::Instant;

use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::activity_log::{
    emit_activity, ActivityKind, ActivityLogEntryBuilder, Metric, Origin,
};
use crate::modules::dynamo::client::DynamoClientRegistry;
use crate::modules::dynamo::tables::describe::describe_table;
use crate::modules::dynamo::tables::list::{run_pager, DynamoPageProvider};
use crate::modules::dynamo::tables::types::{ListTablesResult, TableDescription};
use crate::platform::{settings, DbState};

// Default cap when neither the per-call argument nor the connection setting is set.
const DEFAULT_TABLES_CAP: u32 = 1000;

// ---------------------------------------------------------------------------
// Helper: resolve the effective cap
// ---------------------------------------------------------------------------

fn resolve_cap(
    per_call_cap: Option<u32>,
    db: &State<'_, DbState>,
    connection_id: &Uuid,
) -> u32 {
    // 1. Per-call argument wins.
    if let Some(c) = per_call_cap {
        return c;
    }

    // 2. Per-connection settings key.
    let setting_key = format!("dynamoTablesCap:{connection_id}");
    let from_settings = (|| -> Option<u32> {
        let guard = db.0.lock().ok()?;
        let raw = settings::get(&guard, &setting_key).ok()??;
        raw.parse::<u32>().ok()
    })();
    if let Some(c) = from_settings {
        return c;
    }

    // 3. Default.
    DEFAULT_TABLES_CAP
}

// ---------------------------------------------------------------------------
// Internal helper: load DynamoParams and run the credential-expiry helper.
// Mirrors the pattern in the existing dynamo commands module.
// ---------------------------------------------------------------------------

async fn handle_aws_err(
    db: &State<'_, DbState>,
    registry: &State<'_, DynamoClientRegistry>,
    connection_id: &Uuid,
    app_err: AppError,
) -> AppError {
    use rusqlite::OptionalExtension;
    use crate::modules::dynamo::params::DynamoParams;

    let params_opt: Option<DynamoParams> = (|| {
        let guard = db.0.lock().ok()?;
        let row: Option<String> = guard
            .query_row(
                "SELECT params_json FROM connections WHERE id = ?1",
                rusqlite::params![connection_id.as_bytes().to_vec()],
                |r| r.get(0),
            )
            .optional()
            .ok()?;
        let params_json: serde_json::Value = serde_json::from_str(&row?).ok()?;
        DynamoParams::from_json(&params_json).ok()
    })();

    if let Some(params) = params_opt {
        maybe_access_keys_expired_local(db, registry, connection_id, &params, app_err).await
    } else {
        app_err
    }
}

/// Local re-implementation of the credential-expiry helper from the parent
/// `dynamo::commands` module.  We duplicate the logic here to avoid exporting
/// private helpers across module boundaries; the implementation is identical
/// to `maybe_access_keys_expired` in `dynamo/commands.rs`.
async fn maybe_access_keys_expired_local(
    db: &State<'_, DbState>,
    registry: &State<'_, DynamoClientRegistry>,
    id: &Uuid,
    params: &crate::modules::dynamo::params::DynamoParams,
    app_err: AppError,
) -> AppError {
    use crate::modules::dynamo::params::DynamoAuth;
    use crate::platform::secrets;

    if !matches!(params.auth, DynamoAuth::AccessKeys) {
        return app_err;
    }
    if let AppError::Aws(body) = &app_err {
        let is_session_expired = matches!(
            body.code.as_str(),
            "ExpiredToken" | "ExpiredTokenException" | "InvalidClientTokenId" | "RequestExpired"
        );
        if !is_session_expired {
            return app_err;
        }

        let secret_str = match secrets::get(id) {
            Ok(Some(s)) => s,
            _ => return app_err,
        };
        let has_session_token = serde_json::from_str::<serde_json::Value>(&secret_str)
            .ok()
            .and_then(|v| {
                v.get("session_token")
                    .and_then(|t| t.as_str())
                    .map(|s| !s.is_empty())
            })
            .unwrap_or(false);
        if !has_session_token {
            return app_err;
        }

        // Mark needs_credentials = true.
        let mut new_params = params.clone();
        new_params.needs_credentials = Some(true);
        let _ = update_connection_params_local(db, id, new_params.to_json());

        // Evict the cached client.
        let _ = registry.remove(id).await;
    }
    app_err
}

fn update_connection_params_local(
    db: &State<'_, DbState>,
    id: &Uuid,
    new_params: crate::error::AppResult<serde_json::Value>,
) -> crate::error::AppResult<()> {
    let new_params_json = serde_json::to_string(&new_params?)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let guard = db
        .0
        .lock()
        .map_err(|_| AppError::Internal("db lock poisoned".into()))?;
    guard.execute(
        "UPDATE connections SET params_json = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![new_params_json, now, id.as_bytes().to_vec()],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// §2  dynamo_list_tables
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn dynamo_list_tables(
    app: AppHandle,
    db: State<'_, DbState>,
    registry: State<'_, DynamoClientRegistry>,
    connection_id: Uuid,
    pagination_token: Option<String>,
    cap: Option<u32>,
    origin: Origin,
) -> AppResult<ListTablesResult> {
    let started = Instant::now();

    // Resolve cap (sync DB read, before any async work).
    let effective_cap = resolve_cap(cap, &db, &connection_id);

    // Acquire the client.
    let client = match registry.acquire(&connection_id).await {
        Ok(c) => c,
        Err(e) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::ListTables, origin, duration_ms)
                    .connection(connection_id)
                    .err(&e),
            );
            return Err(e);
        }
    };

    let provider = DynamoPageProvider { client };
    let result = run_pager(&provider, pagination_token.as_deref(), effective_cap).await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(list_result) => {
            let count = list_result.tables.len() as u32;
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::ListTables, origin, duration_ms)
                    .connection(connection_id)
                    .ok(Some(Metric::Items { value: count })),
            );
            Ok(list_result)
        }
        Err(app_err) => {
            let app_err = handle_aws_err(&db, &registry, &connection_id, app_err).await;
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::ListTables, origin, duration_ms)
                    .connection(connection_id)
                    .err(&app_err),
            );
            Err(app_err)
        }
    }
}

// ---------------------------------------------------------------------------
// §3  dynamo_describe_table
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn dynamo_describe_table(
    app: AppHandle,
    db: State<'_, DbState>,
    registry: State<'_, DynamoClientRegistry>,
    connection_id: Uuid,
    table_name: String,
    origin: Origin,
) -> AppResult<TableDescription> {
    let started = Instant::now();

    // Acquire the client.
    let client = match registry.acquire(&connection_id).await {
        Ok(c) => c,
        Err(e) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::DescribeTable, origin, duration_ms)
                    .connection(connection_id)
                    .err(&e),
            );
            return Err(e);
        }
    };

    let result = describe_table(&client, &table_name).await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(desc) => {
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::DescribeTable, origin, duration_ms)
                    .connection(connection_id)
                    .ok(Some(Metric::Items { value: 1 })),
            );
            Ok(desc)
        }
        Err(app_err) => {
            let app_err = handle_aws_err(&db, &registry, &connection_id, app_err).await;
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::DescribeTable, origin, duration_ms)
                    .connection(connection_id)
                    .err(&app_err),
            );
            Err(app_err)
        }
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Test: NotFound is returned when registry has no client for the id.
    // We test the registry `acquire` directly (which is the exact call the
    // command makes) — no Tauri AppHandle needed.
    // -----------------------------------------------------------------------

    fn make_test_client(region: &str) -> aws_sdk_dynamodb::Client {
        use aws_sdk_dynamodb::config::{BehaviorVersion, Credentials, Region};
        let config = aws_sdk_dynamodb::Config::builder()
            .region(Region::new(region.to_string()))
            .credentials_provider(Credentials::new("AKIATEST", "secret", None, None, "test"))
            .behavior_version(BehaviorVersion::latest())
            .build();
        aws_sdk_dynamodb::Client::from_conf(config)
    }

    #[tokio::test]
    async fn acquire_missing_client_returns_not_found() {
        let registry = DynamoClientRegistry::new();
        let id = Uuid::new_v4();
        let err = registry.acquire(&id).await.unwrap_err();
        assert!(
            matches!(err, AppError::NotFound(_)),
            "expected NotFound for listTables/describeTable when registry is empty, got {err:?}"
        );
    }

    #[tokio::test]
    async fn acquire_registered_client_succeeds() {
        use crate::modules::dynamo::client::ActiveDynamoClient;
        let registry = DynamoClientRegistry::new();
        let id = Uuid::new_v4();
        registry
            .insert(
                id,
                ActiveDynamoClient {
                    client: make_test_client("us-east-1"),
                    account_id: "123456789012".into(),
                    identity_arn: "arn:aws:iam::123456789012:user/test".into(),
                    region: "us-east-1".into(),
                    read_only: false,
                    connected_at_unix_ms: 0,
                },
            )
            .await;
        let _ = registry.acquire(&id).await.unwrap();
    }

    // -----------------------------------------------------------------------
    // Activity-log builder shape tests (pure, no State/AppHandle)
    // -----------------------------------------------------------------------

    #[test]
    fn list_tables_ok_activity_shape() {
        let id = Uuid::nil();
        let entry = ActivityLogEntryBuilder::new(ActivityKind::ListTables, Origin::Auto, 55)
            .connection(id)
            .ok(Some(Metric::Items { value: 42 }));
        let v = serde_json::to_value(&entry).unwrap();
        assert_eq!(v["kind"], "list_tables");
        assert_eq!(v["status"], "ok");
        assert_eq!(v["origin"], "auto");
        assert_eq!(v["metric"]["kind"], "items");
        assert_eq!(v["metric"]["value"], 42);
    }

    #[test]
    fn describe_table_ok_activity_shape() {
        let id = Uuid::nil();
        let entry = ActivityLogEntryBuilder::new(ActivityKind::DescribeTable, Origin::User, 30)
            .connection(id)
            .ok(Some(Metric::Items { value: 1 }));
        let v = serde_json::to_value(&entry).unwrap();
        assert_eq!(v["kind"], "describe_table");
        assert_eq!(v["status"], "ok");
        assert_eq!(v["metric"]["value"], 1);
    }

    #[test]
    fn list_tables_err_activity_shape() {
        let id = Uuid::nil();
        let err = AppError::NotFound("dynamo client xxx not active".into());
        let entry = ActivityLogEntryBuilder::new(ActivityKind::ListTables, Origin::Auto, 5)
            .connection(id)
            .err(&err);
        let v = serde_json::to_value(&entry).unwrap();
        assert_eq!(v["kind"], "list_tables");
        assert_eq!(v["status"], "err");
        assert!(v["metric"].is_null());
    }

    #[test]
    fn describe_table_err_activity_shape() {
        let id = Uuid::nil();
        let err = AppError::NotFound("dynamo client xxx not active".into());
        let entry = ActivityLogEntryBuilder::new(ActivityKind::DescribeTable, Origin::Auto, 5)
            .connection(id)
            .err(&err);
        let v = serde_json::to_value(&entry).unwrap();
        assert_eq!(v["kind"], "describe_table");
        assert_eq!(v["status"], "err");
        assert!(v["metric"].is_null());
    }
}
