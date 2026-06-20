use std::time::{Duration, Instant};

use rusqlite::OptionalExtension;
use tauri::{Emitter, State};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::activity_log::{
    emit_activity, ActivityKind, ActivityLogEntryBuilder, Metric, Origin,
};
use crate::modules::athena::client::build_athena_clients;
use crate::modules::athena::errors::maybe_sso_specialized;
use crate::modules::athena::params::AthenaParams;
use crate::modules::athena::pool::{ActiveAthenaClient, ActivePoolSummary, AthenaClientRegistry};
use crate::platform::open_connections::OpenConnectionsRegistry;
use crate::platform::{secrets, DbState};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ATHENA_TIMEOUT: Duration = Duration::from_secs(8);
const ACTIVE_CHANGED_EVENT: &str = "athena:active-changed";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Load AthenaParams + optional keychain secret for a connection id.
fn load_athena_input(
    db: &State<'_, DbState>,
    id: &Uuid,
) -> AppResult<(AthenaParams, Option<String>)> {
    let guard = db
        .0
        .lock()
        .map_err(|_| AppError::Internal("db lock poisoned".into()))?;
    let row: Option<(String, String)> = guard
        .query_row(
            "SELECT kind, params_json FROM connections WHERE id = ?1",
            rusqlite::params![id.as_bytes().to_vec()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (kind, params_json) =
        row.ok_or_else(|| AppError::NotFound(format!("connection {id} not found")))?;
    if kind != "athena" {
        return Err(AppError::Validation(format!(
            "connection {id} kind is {kind}, expected athena"
        )));
    }
    let params_value: serde_json::Value = serde_json::from_str(&params_json)?;
    let params = AthenaParams::from_json(&params_value)?;
    let secret = secrets::get(id)?;
    Ok((params, secret))
}

// ---------------------------------------------------------------------------
// athena_test_connection
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn athena_test_connection(
    app: tauri::AppHandle,
    params: serde_json::Value,
    secret: Option<String>,
) -> AppResult<serde_json::Value> {
    let started = Instant::now();
    let parsed: AthenaParams = serde_json::from_value(params)
        .map_err(|e| AppError::Validation(format!("invalid params: {e}")))?;

    if let Err(e) = parsed.validate(secret.as_deref()) {
        let duration_ms = started.elapsed().as_millis() as u64;
        emit_activity(
            &app,
            ActivityLogEntryBuilder::new(ActivityKind::TestConnection, Origin::User, duration_ms)
                .err(&e),
        );
        return Ok(serde_json::json!({ "ok": false, "error": e }));
    }

    let secret_ref = secret.clone();
    let run = build_athena_clients(&parsed, secret_ref.as_deref());
    let result = tokio::time::timeout(ATHENA_TIMEOUT, run).await;

    let duration_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(Ok(built)) => {
            let metric = Metric::AwsIdentity {
                value: format!("{}:{}", built.account_id, built.identity_arn),
            };
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(
                    ActivityKind::TestConnection,
                    Origin::User,
                    duration_ms,
                )
                .ok(Some(metric)),
            );
            Ok(serde_json::json!({
                "ok": true,
                "latencyMs": duration_ms,
                "accountId": built.account_id,
                "identityArn": built.identity_arn,
                "region": parsed.region,
            }))
        }
        Ok(Err(app_err)) => {
            let app_err = maybe_sso_specialized(app_err, parsed.profile.as_deref());
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(
                    ActivityKind::TestConnection,
                    Origin::User,
                    duration_ms,
                )
                .err(&app_err),
            );
            Ok(serde_json::json!({ "ok": false, "error": app_err }))
        }
        Err(_) => {
            let app_err = AppError::aws("Timeout", "Test connection exceeded 8s budget", true);
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(
                    ActivityKind::TestConnection,
                    Origin::User,
                    duration_ms,
                )
                .err(&app_err),
            );
            Ok(serde_json::json!({ "ok": false, "error": app_err }))
        }
    }
}

// ---------------------------------------------------------------------------
// athena_connect
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn athena_connect(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    registry: State<'_, AthenaClientRegistry>,
    open_registry: State<'_, OpenConnectionsRegistry>,
    id: String,
) -> AppResult<serde_json::Value> {
    let id = Uuid::parse_str(&id)
        .map_err(|e| AppError::Validation(format!("invalid uuid: {e}")))?;

    let started = Instant::now();

    // Idempotent: return existing.
    if let Some(view) = registry.snapshot(&id).await {
        return Ok(serde_json::json!({
            "accountId": view.account_id,
            "region": view.region,
            "readOnly": view.read_only,
        }));
    }

    let (params, secret) = load_athena_input(&db, &id)?;

    let res = tokio::time::timeout(
        ATHENA_TIMEOUT,
        build_athena_clients(&params, secret.as_deref()),
    )
    .await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match res {
        Ok(Ok(built)) => {
            let active = ActiveAthenaClient {
                athena: built.athena,
                glue: built.glue,
                account_id: built.account_id.clone(),
                identity_arn: built.identity_arn.clone(),
                region: params.region.clone(),
                workgroup: params.workgroup.clone(),
                output_location: params.output_location.clone(),
                read_only: params.read_only,
                connected_at_unix_ms: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0),
            };
            registry.insert(id, active).await;
            let _ = app.emit(ACTIVE_CHANGED_EVENT, ());
            open_registry.mark_open(&app, &db, id).await;
            let metric = Metric::AwsIdentity {
                value: format!("{}:{}", built.account_id, built.identity_arn),
            };
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::Connect, Origin::User, duration_ms)
                    .connection(id)
                    .ok(Some(metric)),
            );
            Ok(serde_json::json!({
                "accountId": built.account_id,
                "identityArn": built.identity_arn,
                "region": params.region,
                "readOnly": params.read_only,
            }))
        }
        Ok(Err(app_err)) => {
            let app_err = maybe_sso_specialized(app_err, params.profile.as_deref());
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::Connect, Origin::User, duration_ms)
                    .connection(id)
                    .err(&app_err),
            );
            Err(app_err)
        }
        Err(_) => {
            let app_err = AppError::aws("Timeout", "Connect exceeded 8s budget", true);
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::Connect, Origin::User, duration_ms)
                    .connection(id)
                    .err(&app_err),
            );
            Err(app_err)
        }
    }
}

// ---------------------------------------------------------------------------
// athena_disconnect
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn athena_disconnect(
    app: tauri::AppHandle,
    registry: State<'_, AthenaClientRegistry>,
    open_registry: State<'_, OpenConnectionsRegistry>,
    id: String,
) -> AppResult<()> {
    let id = Uuid::parse_str(&id)
        .map_err(|e| AppError::Validation(format!("invalid uuid: {e}")))?;
    let started = Instant::now();
    let removed = registry.remove(&id).await;
    let duration_ms = started.elapsed().as_millis() as u64;
    if removed {
        let _ = app.emit(ACTIVE_CHANGED_EVENT, ());
        open_registry.mark_closed(&app, id).await;
    }
    emit_activity(
        &app,
        ActivityLogEntryBuilder::new(ActivityKind::Disconnect, Origin::User, duration_ms)
            .connection(id)
            .ok(None),
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// athena_disconnect_all
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn athena_disconnect_all(
    app: tauri::AppHandle,
    registry: State<'_, AthenaClientRegistry>,
    open_registry: State<'_, OpenConnectionsRegistry>,
) -> AppResult<usize> {
    let started = Instant::now();
    let count = registry.disconnect_all().await;
    let duration_ms = started.elapsed().as_millis() as u64;
    if count > 0 {
        let _ = app.emit(ACTIVE_CHANGED_EVENT, ());
        open_registry.mark_kind_closed(&app, "athena").await;
    }
    emit_activity(
        &app,
        ActivityLogEntryBuilder::new(ActivityKind::Disconnect, Origin::User, duration_ms)
            .ok(None),
    );
    Ok(count)
}

// ---------------------------------------------------------------------------
// athena_list_active
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn athena_list_active(
    registry: State<'_, AthenaClientRegistry>,
) -> AppResult<Vec<ActivePoolSummary>> {
    Ok(registry.list_active().await)
}

// ---------------------------------------------------------------------------
// athena_list_aws_profiles
//
// Decision: dynamo already exposes `dynamo_list_aws_profiles` which calls the
// same `aws_profiles::list_profiles` function. Since the frontend can reuse the
// existing command (profile listing is engine-neutral — same ~/.aws files), we
// do NOT add a separate `athena_list_aws_profiles` command. The Athena connection
// form reuses `dynamo_list_aws_profiles` on the frontend.
// ---------------------------------------------------------------------------
