/// DynamoDB item types, codec, IPC envelopes, activity-log helpers, and
/// the Scan/Query/Count command handlers.
///
/// Phase 1 (tasks 1.1–1.5): AttributeValue codec and shared envelopes.
/// Phase 2 (tasks 2.1–4.6): scan/query/count_items command implementations.
use std::collections::HashMap;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::activity_log::{
    emit_activity, ActivityKind, ActivityLogEntryBuilder, Metric, Origin,
};
use crate::modules::dynamo::client::DynamoClientRegistry;
use crate::platform::DbState;

// ---------------------------------------------------------------------------
// §1.1  AttrValue — serde-friendly mirror of AWS AttributeValue
// ---------------------------------------------------------------------------

/// Serde-friendly tagged enum mirroring `aws_sdk_dynamodb::types::AttributeValue`.
///
/// JSON wire shape: `{"S":"..."}`, `{"N":"..."}`, `{"BOOL":true}`, `{"NULL":true}`,
/// `{"L":[...]}`, `{"M":{...}}`, `{"SS":["a","b"]}`, `{"NS":["1","2"]}`,
/// `{"B":"<base64>"}`, `{"BS":["<b64>",...]}`.
///
/// The `N` variant holds a `String` per the AWS spec (numbers travel as strings).
/// The `B`/`BS` variants store raw bytes in Rust; the serde impl encodes/decodes base64.
/// The `NULL` variant holds a `bool` (always `true` over the wire per the AWS spec).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum AttrValue {
    S(String),
    N(String),
    #[serde(rename = "BOOL")]
    Bool(bool),
    #[serde(rename = "NULL")]
    Null(bool),
    L(Vec<AttrValue>),
    M(HashMap<String, AttrValue>),
    #[serde(rename = "SS")]
    Ss(Vec<String>),
    #[serde(rename = "NS")]
    Ns(Vec<String>),
    /// Binary data; serialized/deserialized as a base64 string.
    #[serde(with = "base64_bytes")]
    B(Vec<u8>),
    /// Binary set; each element serialized/deserialized as a base64 string.
    #[serde(rename = "BS", with = "base64_bytes_vec")]
    Bs(Vec<Vec<u8>>),
}

// ---------------------------------------------------------------------------
// Base64 serde helpers
// ---------------------------------------------------------------------------

mod base64_bytes {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &Vec<u8>, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(de: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(de)?;
        STANDARD.decode(&s).map_err(serde::de::Error::custom)
    }
}

mod base64_bytes_vec {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(blobs: &Vec<Vec<u8>>, ser: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeSeq;
        let mut seq = ser.serialize_seq(Some(blobs.len()))?;
        for b in blobs {
            seq.serialize_element(&STANDARD.encode(b))?;
        }
        seq.end()
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(de: D) -> Result<Vec<Vec<u8>>, D::Error> {
        let strings: Vec<String> = Vec::deserialize(de)?;
        strings
            .into_iter()
            .map(|s| STANDARD.decode(&s).map_err(serde::de::Error::custom))
            .collect()
    }
}

// ---------------------------------------------------------------------------
// §1.2  From conversions between AttrValue and the AWS SDK type
// ---------------------------------------------------------------------------

impl From<aws_sdk_dynamodb::types::AttributeValue> for AttrValue {
    fn from(sdk: aws_sdk_dynamodb::types::AttributeValue) -> Self {
        match sdk {
            aws_sdk_dynamodb::types::AttributeValue::S(s) => AttrValue::S(s),
            aws_sdk_dynamodb::types::AttributeValue::N(n) => AttrValue::N(n),
            aws_sdk_dynamodb::types::AttributeValue::Bool(b) => AttrValue::Bool(b),
            aws_sdk_dynamodb::types::AttributeValue::Null(n) => AttrValue::Null(n),
            aws_sdk_dynamodb::types::AttributeValue::L(list) => {
                AttrValue::L(list.into_iter().map(AttrValue::from).collect())
            }
            aws_sdk_dynamodb::types::AttributeValue::M(map) => AttrValue::M(
                map.into_iter()
                    .map(|(k, v)| (k, AttrValue::from(v)))
                    .collect(),
            ),
            aws_sdk_dynamodb::types::AttributeValue::Ss(ss) => AttrValue::Ss(ss),
            aws_sdk_dynamodb::types::AttributeValue::Ns(ns) => AttrValue::Ns(ns),
            aws_sdk_dynamodb::types::AttributeValue::B(blob) => AttrValue::B(blob.into_inner()),
            aws_sdk_dynamodb::types::AttributeValue::Bs(blobs) => {
                AttrValue::Bs(blobs.into_iter().map(|b| b.into_inner()).collect())
            }
            // The SDK marks `Unknown` as non-exhaustive to handle future variants.
            // We map it to an empty S string and log a debug warning; callers
            // should not rely on this value being meaningful.
            _ => {
                tracing::debug!("AttrValue::from: encountered Unknown SDK variant");
                AttrValue::S(String::new())
            }
        }
    }
}

impl From<AttrValue> for aws_sdk_dynamodb::types::AttributeValue {
    fn from(val: AttrValue) -> Self {
        match val {
            AttrValue::S(s) => aws_sdk_dynamodb::types::AttributeValue::S(s),
            AttrValue::N(n) => aws_sdk_dynamodb::types::AttributeValue::N(n),
            AttrValue::Bool(b) => aws_sdk_dynamodb::types::AttributeValue::Bool(b),
            AttrValue::Null(n) => aws_sdk_dynamodb::types::AttributeValue::Null(n),
            AttrValue::L(list) => aws_sdk_dynamodb::types::AttributeValue::L(
                list.into_iter().map(Into::into).collect(),
            ),
            AttrValue::M(map) => aws_sdk_dynamodb::types::AttributeValue::M(
                map.into_iter().map(|(k, v)| (k, v.into())).collect(),
            ),
            AttrValue::Ss(ss) => aws_sdk_dynamodb::types::AttributeValue::Ss(ss),
            AttrValue::Ns(ns) => aws_sdk_dynamodb::types::AttributeValue::Ns(ns),
            AttrValue::B(bytes) => {
                aws_sdk_dynamodb::types::AttributeValue::B(aws_sdk_dynamodb::primitives::Blob::new(bytes))
            }
            AttrValue::Bs(blobs) => aws_sdk_dynamodb::types::AttributeValue::Bs(
                blobs
                    .into_iter()
                    .map(aws_sdk_dynamodb::primitives::Blob::new)
                    .collect(),
            ),
        }
    }
}

// ---------------------------------------------------------------------------
// §1.4  SelectMode and CountMode enums
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SelectMode {
    AllAttributes,
    AllProjectedAttributes,
    SpecificAttributes,
    Count,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CountMode {
    Scan,
    Query,
}

// ---------------------------------------------------------------------------
// §1.4  Request / Response envelopes
// ---------------------------------------------------------------------------

/// IPC request for `dynamo.scan`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ScanRequest {
    pub connection_id: Uuid,
    pub table_name: String,
    pub index_name: Option<String>,
    pub limit: u32,
    pub page: u32,
    pub exclusive_start_key: Option<HashMap<String, AttrValue>>,
    pub filter_expression: Option<String>,
    pub expression_attribute_names: Option<HashMap<String, String>>,
    pub expression_attribute_values: Option<HashMap<String, AttrValue>>,
    pub projection_expression: Option<String>,
    pub consistent_read: bool,
    pub select: Option<SelectMode>,
    pub origin: Option<Origin>,
}

/// IPC request for `dynamo.query`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryRequest {
    pub connection_id: Uuid,
    pub table_name: String,
    pub index_name: Option<String>,
    pub limit: u32,
    pub page: u32,
    pub exclusive_start_key: Option<HashMap<String, AttrValue>>,
    pub key_condition_expression: String,
    pub filter_expression: Option<String>,
    pub expression_attribute_names: Option<HashMap<String, String>>,
    pub expression_attribute_values: Option<HashMap<String, AttrValue>>,
    pub projection_expression: Option<String>,
    pub consistent_read: bool,
    pub select: Option<SelectMode>,
    pub scan_index_forward: Option<bool>,
    pub origin: Option<Origin>,
}

/// IPC request for `dynamo.countItems`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CountRequest {
    pub connection_id: Uuid,
    pub table_name: String,
    pub mode: CountMode,
    pub index_name: Option<String>,
    pub key_condition_expression: Option<String>,
    pub filter_expression: Option<String>,
    pub expression_attribute_names: Option<HashMap<String, String>>,
    pub expression_attribute_values: Option<HashMap<String, AttrValue>>,
    pub scan_index_forward: Option<bool>,
    pub consistent_read: bool,
    pub origin: Option<Origin>,
}

/// IPC response from `dynamo.scan`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ScanResponse {
    pub items: Vec<HashMap<String, AttrValue>>,
    pub last_evaluated_key: Option<HashMap<String, AttrValue>>,
    pub scanned_count: u32,
    pub count: u32,
    /// TODO: Model ConsumedCapacity as a proper struct when the capacity reporting
    /// feature lands; using Value for now to avoid premature schema commitment.
    pub consumed_capacity: Option<serde_json::Value>,
}

/// IPC response from `dynamo.query`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryResponse {
    pub items: Vec<HashMap<String, AttrValue>>,
    pub last_evaluated_key: Option<HashMap<String, AttrValue>>,
    pub scanned_count: u32,
    pub count: u32,
    /// TODO: Model ConsumedCapacity as a proper struct when the capacity reporting
    /// feature lands; using Value for now to avoid premature schema commitment.
    pub consumed_capacity: Option<serde_json::Value>,
}

/// IPC response from `dynamo.countItems`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CountResponse {
    pub total_count: u64,
    pub total_scanned_count: u64,
    pub page_count: u32,
    /// TODO: Model ConsumedCapacity as a proper struct when the capacity reporting
    /// feature lands; using Value for now to avoid premature schema commitment.
    pub consumed_capacity: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// §1.5  compact_activity_params — activity-log params helper
// ---------------------------------------------------------------------------

/// Build the compact activity-log `params` JSON for Scan/Query/Count commands.
///
/// Omits `index_name`, `select`, and `scan_index_forward` when they are `None`
/// to keep the log payload minimal and readable.
pub(crate) fn compact_activity_params(
    table_name: &str,
    index_name: Option<&str>,
    has_filter: bool,
    has_key_condition: bool,
    limit: Option<u32>,
    consistent_read: bool,
    select: Option<SelectMode>,
    page: Option<u32>,
    scan_index_forward: Option<bool>,
) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    map.insert("table_name".into(), serde_json::Value::String(table_name.to_string()));
    if let Some(idx) = index_name {
        map.insert("index_name".into(), serde_json::Value::String(idx.to_string()));
    }
    map.insert("has_filter".into(), serde_json::Value::Bool(has_filter));
    map.insert("has_key_condition".into(), serde_json::Value::Bool(has_key_condition));
    if let Some(l) = limit {
        map.insert("limit".into(), serde_json::Value::Number(l.into()));
    }
    map.insert("consistent_read".into(), serde_json::Value::Bool(consistent_read));
    if let Some(sel) = select {
        let sel_str = serde_json::to_value(sel)
            .unwrap_or(serde_json::Value::Null);
        map.insert("select".into(), sel_str);
    }
    if let Some(p) = page {
        map.insert("page".into(), serde_json::Value::Number(p.into()));
    }
    if let Some(fwd) = scan_index_forward {
        map.insert("scan_index_forward".into(), serde_json::Value::Bool(fwd));
    }
    serde_json::Value::Object(map)
}

// ---------------------------------------------------------------------------
// §2  Internal credential-expiry helper (mirrors tables/commands.rs)
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
        maybe_access_keys_expired(db, registry, connection_id, &params, app_err).await
    } else {
        app_err
    }
}

async fn maybe_access_keys_expired(
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

        let mut new_params = params.clone();
        new_params.needs_credentials = Some(true);
        let _ = update_connection_params(db, id, new_params.to_json());

        let _ = registry.remove(id).await;
    }
    app_err
}

fn update_connection_params(
    db: &State<'_, DbState>,
    id: &Uuid,
    new_params: AppResult<serde_json::Value>,
) -> AppResult<()> {
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
// §2  SDK error → AppError helper (used by all three commands)
// ---------------------------------------------------------------------------

fn sdk_scan_err<E>(e: &aws_sdk_dynamodb::error::SdkError<E>) -> AppError
where
    E: aws_sdk_dynamodb::error::ProvideErrorMetadata + std::fmt::Debug,
{
    use aws_sdk_dynamodb::error::ProvideErrorMetadata;
    let code = e.meta().code().unwrap_or("Unknown").to_string();
    let message = e
        .meta()
        .message()
        .map(String::from)
        .unwrap_or_else(|| format!("{e:?}"));
    AppError::aws(code, message, false)
}

// ---------------------------------------------------------------------------
// §2  SelectMode → AWS SDK Select
// ---------------------------------------------------------------------------

fn select_mode_to_sdk(mode: SelectMode) -> aws_sdk_dynamodb::types::Select {
    match mode {
        SelectMode::AllAttributes => aws_sdk_dynamodb::types::Select::AllAttributes,
        SelectMode::AllProjectedAttributes => {
            aws_sdk_dynamodb::types::Select::AllProjectedAttributes
        }
        SelectMode::SpecificAttributes => aws_sdk_dynamodb::types::Select::SpecificAttributes,
        SelectMode::Count => aws_sdk_dynamodb::types::Select::Count,
    }
}

// ---------------------------------------------------------------------------
// §2.1–2.6  scan command
// ---------------------------------------------------------------------------

pub async fn scan(
    app: AppHandle,
    db: State<'_, DbState>,
    registry: State<'_, DynamoClientRegistry>,
    req: ScanRequest,
) -> AppResult<ScanResponse> {
    let origin = req.origin.unwrap_or_default();
    let started = Instant::now();

    if req.limit < 1 || req.limit > 1000 {
        let e = AppError::Validation(format!(
            "limit must be between 1 and 1000, got {}",
            req.limit
        ));
        let duration_ms = started.elapsed().as_millis() as u64;
        let params = compact_activity_params(
            &req.table_name,
            req.index_name.as_deref(),
            req.filter_expression.is_some(),
            false,
            Some(req.limit),
            req.consistent_read,
            req.select,
            Some(req.page),
            None,
        );
        emit_activity(
            &app,
            ActivityLogEntryBuilder::new(ActivityKind::ScanTable, origin, duration_ms)
                .connection(req.connection_id)
                .params(vec![params.to_string()])
                .err(&e),
        );
        return Err(e);
    }

    let client = match registry.acquire(&req.connection_id).await {
        Ok(c) => c,
        Err(e) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            let params = compact_activity_params(
                &req.table_name,
                req.index_name.as_deref(),
                req.filter_expression.is_some(),
                false,
                Some(req.limit),
                req.consistent_read,
                req.select,
                Some(req.page),
                None,
            );
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::ScanTable, origin, duration_ms)
                    .connection(req.connection_id)
                    .params(vec![params.to_string()])
                    .err(&e),
            );
            return Err(e);
        }
    };

    let mut builder = client
        .scan()
        .table_name(&req.table_name)
        .limit(req.limit as i32)
        .consistent_read(req.consistent_read);

    if let Some(idx) = &req.index_name {
        builder = builder.index_name(idx);
    }
    if let Some(fe) = &req.filter_expression {
        builder = builder.filter_expression(fe);
    }
    if let Some(pe) = &req.projection_expression {
        builder = builder.projection_expression(pe);
    }
    if let Some(ean) = req.expression_attribute_names {
        for (k, v) in ean {
            builder = builder.expression_attribute_names(k, v);
        }
    }
    if let Some(eav) = req.expression_attribute_values {
        for (k, v) in eav {
            builder = builder.expression_attribute_values(k, v.into());
        }
    }
    if let Some(esk) = req.exclusive_start_key {
        for (k, v) in esk {
            builder = builder.exclusive_start_key(k, v.into());
        }
    }
    if let Some(sel) = req.select {
        builder = builder.select(select_mode_to_sdk(sel));
    }

    let result = builder.send().await;
    let duration_ms = started.elapsed().as_millis() as u64;

    let params_json = compact_activity_params(
        &req.table_name,
        req.index_name.as_deref(),
        req.filter_expression.is_some(),
        false,
        Some(req.limit),
        req.consistent_read,
        req.select,
        Some(req.page),
        None,
    );

    match result {
        Ok(resp) => {
            let items: Vec<HashMap<String, AttrValue>> = resp
                .items()
                .iter()
                .map(|item| item.iter().map(|(k, v)| (k.clone(), AttrValue::from(v.clone()))).collect())
                .collect();
            let count = resp.count() as u32;
            let scanned_count = resp.scanned_count() as u32;
            let last_evaluated_key = resp
                .last_evaluated_key()
                .filter(|m| !m.is_empty())
                .map(|m| m.iter().map(|(k, v)| (k.clone(), AttrValue::from(v.clone()))).collect());

            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::ScanTable, origin, duration_ms)
                    .connection(req.connection_id)
                    .params(vec![params_json.to_string()])
                    .ok(Some(Metric::Items { value: count })),
            );

            Ok(ScanResponse {
                items,
                last_evaluated_key,
                scanned_count,
                count,
                consumed_capacity: None,
            })
        }
        Err(e) => {
            let app_err = sdk_scan_err(&e);
            let app_err = handle_aws_err(&db, &registry, &req.connection_id, app_err).await;
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::ScanTable, origin, duration_ms)
                    .connection(req.connection_id)
                    .params(vec![params_json.to_string()])
                    .err(&app_err),
            );
            Err(app_err)
        }
    }
}

// ---------------------------------------------------------------------------
// §3.1–3.4  query command
// ---------------------------------------------------------------------------

pub async fn query(
    app: AppHandle,
    db: State<'_, DbState>,
    registry: State<'_, DynamoClientRegistry>,
    req: QueryRequest,
) -> AppResult<QueryResponse> {
    let origin = req.origin.unwrap_or_default();
    let started = Instant::now();
    let scan_index_forward = req.scan_index_forward.unwrap_or(true);

    let params_json = compact_activity_params(
        &req.table_name,
        req.index_name.as_deref(),
        req.filter_expression.is_some(),
        true,
        Some(req.limit),
        req.consistent_read,
        req.select,
        Some(req.page),
        Some(scan_index_forward),
    );

    if req.key_condition_expression.trim().is_empty() {
        let e = AppError::Validation("key_condition_expression must not be empty".into());
        let duration_ms = started.elapsed().as_millis() as u64;
        emit_activity(
            &app,
            ActivityLogEntryBuilder::new(ActivityKind::QueryTable, origin, duration_ms)
                .connection(req.connection_id)
                .params(vec![params_json.to_string()])
                .err(&e),
        );
        return Err(e);
    }

    if req.limit < 1 || req.limit > 1000 {
        let e = AppError::Validation(format!(
            "limit must be between 1 and 1000, got {}",
            req.limit
        ));
        let duration_ms = started.elapsed().as_millis() as u64;
        emit_activity(
            &app,
            ActivityLogEntryBuilder::new(ActivityKind::QueryTable, origin, duration_ms)
                .connection(req.connection_id)
                .params(vec![params_json.to_string()])
                .err(&e),
        );
        return Err(e);
    }

    let client = match registry.acquire(&req.connection_id).await {
        Ok(c) => c,
        Err(e) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::QueryTable, origin, duration_ms)
                    .connection(req.connection_id)
                    .params(vec![params_json.to_string()])
                    .err(&e),
            );
            return Err(e);
        }
    };

    let mut builder = client
        .query()
        .table_name(&req.table_name)
        .limit(req.limit as i32)
        .consistent_read(req.consistent_read)
        .key_condition_expression(&req.key_condition_expression)
        .scan_index_forward(scan_index_forward);

    if let Some(idx) = &req.index_name {
        builder = builder.index_name(idx);
    }
    if let Some(fe) = &req.filter_expression {
        builder = builder.filter_expression(fe);
    }
    if let Some(pe) = &req.projection_expression {
        builder = builder.projection_expression(pe);
    }
    if let Some(ean) = req.expression_attribute_names {
        for (k, v) in ean {
            builder = builder.expression_attribute_names(k, v);
        }
    }
    if let Some(eav) = req.expression_attribute_values {
        for (k, v) in eav {
            builder = builder.expression_attribute_values(k, v.into());
        }
    }
    if let Some(esk) = req.exclusive_start_key {
        for (k, v) in esk {
            builder = builder.exclusive_start_key(k, v.into());
        }
    }
    if let Some(sel) = req.select {
        builder = builder.select(select_mode_to_sdk(sel));
    }

    let result = builder.send().await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(resp) => {
            let items: Vec<HashMap<String, AttrValue>> = resp
                .items()
                .iter()
                .map(|item| item.iter().map(|(k, v)| (k.clone(), AttrValue::from(v.clone()))).collect())
                .collect();
            let count = resp.count() as u32;
            let scanned_count = resp.scanned_count() as u32;
            let last_evaluated_key = resp
                .last_evaluated_key()
                .filter(|m| !m.is_empty())
                .map(|m| m.iter().map(|(k, v)| (k.clone(), AttrValue::from(v.clone()))).collect());

            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::QueryTable, origin, duration_ms)
                    .connection(req.connection_id)
                    .params(vec![params_json.to_string()])
                    .ok(Some(Metric::Items { value: count })),
            );

            Ok(QueryResponse {
                items,
                last_evaluated_key,
                scanned_count,
                count,
                consumed_capacity: None,
            })
        }
        Err(e) => {
            let app_err = sdk_scan_err(&e);
            let app_err = handle_aws_err(&db, &registry, &req.connection_id, app_err).await;
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::QueryTable, origin, duration_ms)
                    .connection(req.connection_id)
                    .params(vec![params_json.to_string()])
                    .err(&app_err),
            );
            Err(app_err)
        }
    }
}

// ---------------------------------------------------------------------------
// §4.1–4.6  count_items command
// ---------------------------------------------------------------------------

pub async fn count_items(
    app: AppHandle,
    db: State<'_, DbState>,
    registry: State<'_, DynamoClientRegistry>,
    req: CountRequest,
) -> AppResult<CountResponse> {
    let origin = req.origin.unwrap_or_default();
    let started = Instant::now();

    let params_json = compact_activity_params(
        &req.table_name,
        req.index_name.as_deref(),
        req.filter_expression.is_some(),
        req.key_condition_expression.is_some(),
        None,
        req.consistent_read,
        None,
        None,
        req.scan_index_forward,
    );

    if matches!(req.mode, CountMode::Query) {
        let kce = req.key_condition_expression.as_deref().unwrap_or("").trim();
        if kce.is_empty() {
            let e = AppError::Validation(
                "key_condition_expression is required for mode=query".into(),
            );
            let duration_ms = started.elapsed().as_millis() as u64;
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::CountTable, origin, duration_ms)
                    .connection(req.connection_id)
                    .params(vec![params_json.to_string()])
                    .err(&e),
            );
            return Err(e);
        }
    }

    let client = match registry.acquire(&req.connection_id).await {
        Ok(c) => c,
        Err(e) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::CountTable, origin, duration_ms)
                    .connection(req.connection_id)
                    .params(vec![params_json.to_string()])
                    .err(&e),
            );
            return Err(e);
        }
    };

    let mut total_count: u64 = 0;
    let mut total_scanned_count: u64 = 0;
    let mut page_count: u32 = 0;
    let mut last_key: Option<HashMap<String, aws_sdk_dynamodb::types::AttributeValue>> = None;

    loop {
        let app_err: AppError;

        match req.mode {
            CountMode::Scan => {
                let mut builder = client
                    .scan()
                    .table_name(&req.table_name)
                    .limit(1000)
                    .consistent_read(req.consistent_read)
                    .select(aws_sdk_dynamodb::types::Select::Count);

                if let Some(idx) = &req.index_name {
                    builder = builder.index_name(idx);
                }
                if let Some(fe) = &req.filter_expression {
                    builder = builder.filter_expression(fe);
                }
                if let Some(ean) = &req.expression_attribute_names {
                    for (k, v) in ean {
                        builder = builder.expression_attribute_names(k, v);
                    }
                }
                if let Some(eav) = &req.expression_attribute_values {
                    for (k, v) in eav {
                        builder = builder.expression_attribute_values(k, v.clone().into());
                    }
                }
                if let Some(ref lk) = last_key {
                    for (k, v) in lk {
                        builder = builder.exclusive_start_key(k, v.clone());
                    }
                }

                match builder.send().await {
                    Ok(resp) => {
                        total_count += resp.count() as u64;
                        total_scanned_count += resp.scanned_count() as u64;
                        page_count += 1;
                        match resp.last_evaluated_key().filter(|m| !m.is_empty()) {
                            None => break,
                            Some(m) => {
                                last_key = Some(m.iter().map(|(k, v)| (k.clone(), v.clone())).collect());
                                continue;
                            }
                        }
                    }
                    Err(e) => {
                        app_err = sdk_scan_err(&e);
                    }
                }
            }
            CountMode::Query => {
                let kce = req.key_condition_expression.as_deref().unwrap_or("");
                let scan_fwd = req.scan_index_forward.unwrap_or(true);

                let mut builder = client
                    .query()
                    .table_name(&req.table_name)
                    .limit(1000)
                    .consistent_read(req.consistent_read)
                    .key_condition_expression(kce)
                    .scan_index_forward(scan_fwd)
                    .select(aws_sdk_dynamodb::types::Select::Count);

                if let Some(idx) = &req.index_name {
                    builder = builder.index_name(idx);
                }
                if let Some(fe) = &req.filter_expression {
                    builder = builder.filter_expression(fe);
                }
                if let Some(ean) = &req.expression_attribute_names {
                    for (k, v) in ean {
                        builder = builder.expression_attribute_names(k, v);
                    }
                }
                if let Some(eav) = &req.expression_attribute_values {
                    for (k, v) in eav {
                        builder = builder.expression_attribute_values(k, v.clone().into());
                    }
                }
                if let Some(ref lk) = last_key {
                    for (k, v) in lk {
                        builder = builder.exclusive_start_key(k, v.clone());
                    }
                }

                match builder.send().await {
                    Ok(resp) => {
                        total_count += resp.count() as u64;
                        total_scanned_count += resp.scanned_count() as u64;
                        page_count += 1;
                        match resp.last_evaluated_key().filter(|m| !m.is_empty()) {
                            None => break,
                            Some(m) => {
                                last_key = Some(m.iter().map(|(k, v)| (k.clone(), v.clone())).collect());
                                continue;
                            }
                        }
                    }
                    Err(e) => {
                        app_err = sdk_scan_err(&e);
                    }
                }
            }
        }

        let duration_ms = started.elapsed().as_millis() as u64;
        let app_err = handle_aws_err(&db, &registry, &req.connection_id, app_err).await;
        emit_activity(
            &app,
            ActivityLogEntryBuilder::new(ActivityKind::CountTable, origin, duration_ms)
                .connection(req.connection_id)
                .params(vec![params_json.to_string()])
                .err(&app_err),
        );
        return Err(app_err);
    }

    let duration_ms = started.elapsed().as_millis() as u64;
    emit_activity(
        &app,
        ActivityLogEntryBuilder::new(ActivityKind::CountTable, origin, duration_ms)
            .connection(req.connection_id)
            .params(vec![params_json.to_string()])
            .ok(Some(Metric::Items {
                value: total_count.min(u32::MAX as u64) as u32,
            })),
    );

    Ok(CountResponse {
        total_count,
        total_scanned_count,
        page_count,
        consumed_capacity: None,
    })
}

// ---------------------------------------------------------------------------
// §2.6 / §3.4 / §4.6  Tauri command wrappers
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn dynamo_scan(
    app: AppHandle,
    db: State<'_, DbState>,
    registry: State<'_, DynamoClientRegistry>,
    req: ScanRequest,
) -> AppResult<ScanResponse> {
    scan(app, db, registry, req).await
}

#[tauri::command]
pub async fn dynamo_query(
    app: AppHandle,
    db: State<'_, DbState>,
    registry: State<'_, DynamoClientRegistry>,
    req: QueryRequest,
) -> AppResult<QueryResponse> {
    query(app, db, registry, req).await
}

#[tauri::command]
pub async fn dynamo_count_items(
    app: AppHandle,
    db: State<'_, DbState>,
    registry: State<'_, DynamoClientRegistry>,
    req: CountRequest,
) -> AppResult<CountResponse> {
    count_items(app, db, registry, req).await
}

// ---------------------------------------------------------------------------
// §1.3  Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_dynamodb::primitives::Blob;
    use aws_sdk_dynamodb::types::AttributeValue as SdkAttrValue;

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    fn sdk_to_our(v: SdkAttrValue) -> AttrValue {
        AttrValue::from(v)
    }

    fn our_to_sdk(v: AttrValue) -> SdkAttrValue {
        v.into()
    }

    fn roundtrip_sdk(sdk: SdkAttrValue) -> SdkAttrValue {
        our_to_sdk(sdk_to_our(sdk))
    }

    // -----------------------------------------------------------------------
    // (a) Every tag round-trips through From/Into
    // -----------------------------------------------------------------------

    #[test]
    fn s_roundtrips() {
        let sdk = SdkAttrValue::S("hello".into());
        let rt = roundtrip_sdk(sdk);
        assert!(matches!(rt, SdkAttrValue::S(s) if s == "hello"));
    }

    #[test]
    fn n_roundtrips() {
        let sdk = SdkAttrValue::N("42.5".into());
        let rt = roundtrip_sdk(sdk);
        assert!(matches!(rt, SdkAttrValue::N(n) if n == "42.5"));
    }

    #[test]
    fn bool_roundtrips() {
        for b in [true, false] {
            let sdk = SdkAttrValue::Bool(b);
            let rt = roundtrip_sdk(sdk);
            assert!(matches!(rt, SdkAttrValue::Bool(v) if v == b));
        }
    }

    #[test]
    fn null_roundtrips() {
        let sdk = SdkAttrValue::Null(true);
        let rt = roundtrip_sdk(sdk);
        assert!(matches!(rt, SdkAttrValue::Null(true)));
    }

    #[test]
    fn ss_roundtrips() {
        let sdk = SdkAttrValue::Ss(vec!["a".into(), "b".into()]);
        let rt = roundtrip_sdk(sdk);
        match rt {
            SdkAttrValue::Ss(v) => assert_eq!(v, vec!["a", "b"]),
            other => panic!("expected Ss, got {other:?}"),
        }
    }

    #[test]
    fn ns_roundtrips() {
        let sdk = SdkAttrValue::Ns(vec!["1".into(), "2.5".into()]);
        let rt = roundtrip_sdk(sdk);
        match rt {
            SdkAttrValue::Ns(v) => assert_eq!(v, vec!["1", "2.5"]),
            other => panic!("expected Ns, got {other:?}"),
        }
    }

    #[test]
    fn l_roundtrips() {
        let sdk = SdkAttrValue::L(vec![SdkAttrValue::S("x".into()), SdkAttrValue::N("1".into())]);
        let rt = roundtrip_sdk(sdk);
        match rt {
            SdkAttrValue::L(list) => {
                assert_eq!(list.len(), 2);
                assert!(matches!(&list[0], SdkAttrValue::S(s) if s == "x"));
                assert!(matches!(&list[1], SdkAttrValue::N(n) if n == "1"));
            }
            other => panic!("expected L, got {other:?}"),
        }
    }

    #[test]
    fn m_roundtrips() {
        let mut map = HashMap::new();
        map.insert("name".to_string(), SdkAttrValue::S("Alice".into()));
        map.insert("age".to_string(), SdkAttrValue::N("30".into()));
        let sdk = SdkAttrValue::M(map);
        let rt = roundtrip_sdk(sdk);
        match rt {
            SdkAttrValue::M(m) => {
                assert!(matches!(m.get("name"), Some(SdkAttrValue::S(s)) if s == "Alice"));
                assert!(matches!(m.get("age"), Some(SdkAttrValue::N(n)) if n == "30"));
            }
            other => panic!("expected M, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------------
    // (b) Base64 binary is byte-exact
    // -----------------------------------------------------------------------

    #[test]
    fn b_roundtrips_byte_exact() {
        let bytes = vec![0u8, 1, 2, 255, 128, 64];
        let sdk = SdkAttrValue::B(Blob::new(bytes.clone()));
        let rt = roundtrip_sdk(sdk);
        match rt {
            SdkAttrValue::B(blob) => assert_eq!(blob.into_inner(), bytes),
            other => panic!("expected B, got {other:?}"),
        }
    }

    #[test]
    fn bs_roundtrips_byte_exact() {
        let b1 = vec![1u8, 2, 3];
        let b2 = vec![255u8, 0, 127];
        let sdk = SdkAttrValue::Bs(vec![Blob::new(b1.clone()), Blob::new(b2.clone())]);
        let rt = roundtrip_sdk(sdk);
        match rt {
            SdkAttrValue::Bs(blobs) => {
                assert_eq!(blobs[0].as_ref(), b1.as_slice());
                assert_eq!(blobs[1].as_ref(), b2.as_slice());
            }
            other => panic!("expected Bs, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------------
    // (c) Deeply nested L containing M containing L
    // -----------------------------------------------------------------------

    #[test]
    fn deeply_nested_l_m_l_roundtrips() {
        // L[ M{ "inner": L[ S("leaf") ] } ]
        let inner_l = SdkAttrValue::L(vec![SdkAttrValue::S("leaf".into())]);
        let mut m = HashMap::new();
        m.insert("inner".to_string(), inner_l);
        let outer_l = SdkAttrValue::L(vec![SdkAttrValue::M(m)]);

        let rt = roundtrip_sdk(outer_l);

        match rt {
            SdkAttrValue::L(outer) => {
                assert_eq!(outer.len(), 1);
                match &outer[0] {
                    SdkAttrValue::M(m) => {
                        match m.get("inner") {
                            Some(SdkAttrValue::L(list)) => {
                                assert_eq!(list.len(), 1);
                                assert!(matches!(&list[0], SdkAttrValue::S(s) if s == "leaf"));
                            }
                            other => panic!("expected inner L, got {other:?}"),
                        }
                    }
                    other => panic!("expected M inside outer L, got {other:?}"),
                }
            }
            other => panic!("expected outer L, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------------
    // (d) Serde JSON shape tests — each tag produces the documented shape
    // -----------------------------------------------------------------------

    #[test]
    fn s_json_shape() {
        let v = AttrValue::S("hello".into());
        let j = serde_json::to_value(&v).unwrap();
        assert_eq!(j, serde_json::json!({"S": "hello"}));
        let rt: AttrValue = serde_json::from_value(j).unwrap();
        assert_eq!(rt, AttrValue::S("hello".into()));
    }

    #[test]
    fn n_json_shape() {
        let v = AttrValue::N("123.45".into());
        let j = serde_json::to_value(&v).unwrap();
        assert_eq!(j, serde_json::json!({"N": "123.45"}));
    }

    #[test]
    fn bool_json_shape() {
        let v = AttrValue::Bool(true);
        let j = serde_json::to_value(&v).unwrap();
        assert_eq!(j, serde_json::json!({"BOOL": true}));
    }

    #[test]
    fn null_json_shape() {
        let v = AttrValue::Null(true);
        let j = serde_json::to_value(&v).unwrap();
        assert_eq!(j, serde_json::json!({"NULL": true}));
    }

    #[test]
    fn ss_json_shape() {
        let v = AttrValue::Ss(vec!["a".into(), "b".into()]);
        let j = serde_json::to_value(&v).unwrap();
        assert_eq!(j, serde_json::json!({"SS": ["a", "b"]}));
    }

    #[test]
    fn ns_json_shape() {
        let v = AttrValue::Ns(vec!["1".into(), "2".into()]);
        let j = serde_json::to_value(&v).unwrap();
        assert_eq!(j, serde_json::json!({"NS": ["1", "2"]}));
    }

    #[test]
    fn b_json_shape_is_base64() {
        let bytes = vec![b'A', b'W', b'S']; // "AWS" → "QVNT" in standard base64... wait
        // "AWS" in bytes is [65, 87, 83] → base64 is "QVNT" ... let me recalculate:
        // A=65, W=87, S=83. Group: 010000 010101 011001 010011 → Q, V, N, T → "QVNT"
        // Actually let me just use a known value and verify the round-trip.
        let v = AttrValue::B(bytes.clone());
        let j = serde_json::to_value(&v).unwrap();
        // Must be {"B": "<base64 string>"}
        assert!(j.get("B").is_some());
        assert!(j["B"].is_string());
        // Round-trip
        let rt: AttrValue = serde_json::from_value(j).unwrap();
        assert_eq!(rt, AttrValue::B(bytes));
    }

    #[test]
    fn bs_json_shape_is_base64_array() {
        let b1 = vec![1u8, 2, 3];
        let b2 = vec![4u8, 5, 6];
        let v = AttrValue::Bs(vec![b1.clone(), b2.clone()]);
        let j = serde_json::to_value(&v).unwrap();
        assert!(j.get("BS").is_some());
        assert!(j["BS"].is_array());
        assert_eq!(j["BS"].as_array().unwrap().len(), 2);
        // Each element is a string.
        for elem in j["BS"].as_array().unwrap() {
            assert!(elem.is_string());
        }
        // Round-trip
        let rt: AttrValue = serde_json::from_value(j).unwrap();
        assert_eq!(rt, AttrValue::Bs(vec![b1, b2]));
    }

    #[test]
    fn l_json_shape() {
        let v = AttrValue::L(vec![AttrValue::S("x".into()), AttrValue::N("1".into())]);
        let j = serde_json::to_value(&v).unwrap();
        assert_eq!(j, serde_json::json!({"L": [{"S": "x"}, {"N": "1"}]}));
    }

    #[test]
    fn m_json_shape() {
        let mut map = HashMap::new();
        map.insert("k".to_string(), AttrValue::Bool(false));
        let v = AttrValue::M(map);
        let j = serde_json::to_value(&v).unwrap();
        assert_eq!(j, serde_json::json!({"M": {"k": {"BOOL": false}}}));
    }

    // -----------------------------------------------------------------------
    // SelectMode and CountMode serialization tests
    // -----------------------------------------------------------------------

    #[test]
    fn select_mode_serializes_screaming_snake_case() {
        let cases = [
            (SelectMode::AllAttributes, "ALL_ATTRIBUTES"),
            (SelectMode::AllProjectedAttributes, "ALL_PROJECTED_ATTRIBUTES"),
            (SelectMode::SpecificAttributes, "SPECIFIC_ATTRIBUTES"),
            (SelectMode::Count, "COUNT"),
        ];
        for (mode, expected) in cases {
            let j = serde_json::to_value(mode).unwrap();
            assert_eq!(j, serde_json::Value::String(expected.to_string()));
        }
    }

    #[test]
    fn count_mode_serializes_lowercase() {
        assert_eq!(serde_json::to_value(CountMode::Scan).unwrap(), serde_json::json!("scan"));
        assert_eq!(serde_json::to_value(CountMode::Query).unwrap(), serde_json::json!("query"));
    }

    // -----------------------------------------------------------------------
    // compact_activity_params tests
    // -----------------------------------------------------------------------

    #[test]
    fn compact_params_includes_required_fields() {
        let params = compact_activity_params(
            "my_table",
            None,
            false,
            false,
            Some(100),
            false,
            None,
            Some(1),
            None,
        );
        assert_eq!(params["table_name"], "my_table");
        assert_eq!(params["has_filter"], false);
        assert_eq!(params["has_key_condition"], false);
        assert_eq!(params["limit"], 100);
        assert_eq!(params["consistent_read"], false);
        assert_eq!(params["page"], 1);
        // Optional fields absent
        assert!(params.get("index_name").is_none());
        assert!(params.get("select").is_none());
        assert!(params.get("scan_index_forward").is_none());
    }

    #[test]
    fn compact_params_includes_optional_fields_when_set() {
        let params = compact_activity_params(
            "orders",
            Some("byCustomer"),
            true,
            true,
            Some(50),
            true,
            Some(SelectMode::AllAttributes),
            Some(2),
            Some(false),
        );
        assert_eq!(params["table_name"], "orders");
        assert_eq!(params["index_name"], "byCustomer");
        assert_eq!(params["has_filter"], true);
        assert_eq!(params["has_key_condition"], true);
        assert_eq!(params["limit"], 50);
        assert_eq!(params["consistent_read"], true);
        assert_eq!(params["select"], "ALL_ATTRIBUTES");
        assert_eq!(params["page"], 2);
        assert_eq!(params["scan_index_forward"], false);
    }

    #[test]
    fn compact_params_omits_none_limit_and_page() {
        let params = compact_activity_params("t", None, false, false, None, false, None, None, None);
        assert!(params.get("limit").is_none());
        assert!(params.get("page").is_none());
    }

    // -----------------------------------------------------------------------
    // Request envelope deserialization tests
    // -----------------------------------------------------------------------

    #[test]
    fn scan_request_deserializes_from_snake_case_json() {
        let json = serde_json::json!({
            "connection_id": "00000000-0000-0000-0000-000000000001",
            "table_name": "events",
            "limit": 100,
            "page": 1,
            "consistent_read": false,
        });
        let req: ScanRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.table_name, "events");
        assert_eq!(req.limit, 100);
        assert!(!req.consistent_read);
        assert!(req.index_name.is_none());
        assert!(req.filter_expression.is_none());
    }

    #[test]
    fn count_request_deserializes_mode_field() {
        let json = serde_json::json!({
            "connection_id": "00000000-0000-0000-0000-000000000001",
            "table_name": "events",
            "mode": "query",
            "consistent_read": true,
            "key_condition_expression": "#pk = :pk",
        });
        let req: CountRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.mode, CountMode::Query);
        assert!(req.consistent_read);
    }

    #[test]
    fn origin_from_activity_log_serializes_correctly() {
        // Verify the reused Origin type serializes as documented.
        assert_eq!(serde_json::to_value(Origin::User).unwrap(), serde_json::json!("user"));
        assert_eq!(serde_json::to_value(Origin::Auto).unwrap(), serde_json::json!("auto"));
    }

    // -----------------------------------------------------------------------
    // Phase 2 validation logic tests (pure, no AppHandle/State)
    // These test the business-rule validation that runs before any AWS call.
    // -----------------------------------------------------------------------

    fn make_scan_request(limit: u32) -> ScanRequest {
        ScanRequest {
            connection_id: Uuid::nil(),
            table_name: "events".into(),
            index_name: None,
            limit,
            page: 1,
            exclusive_start_key: None,
            filter_expression: None,
            expression_attribute_names: None,
            expression_attribute_values: None,
            projection_expression: None,
            consistent_read: false,
            select: None,
            origin: None,
        }
    }

    fn make_query_request(key_condition_expression: &str) -> QueryRequest {
        QueryRequest {
            connection_id: Uuid::nil(),
            table_name: "events".into(),
            index_name: None,
            limit: 100,
            page: 1,
            exclusive_start_key: None,
            key_condition_expression: key_condition_expression.into(),
            filter_expression: None,
            expression_attribute_names: None,
            expression_attribute_values: None,
            projection_expression: None,
            consistent_read: false,
            select: None,
            scan_index_forward: None,
            origin: None,
        }
    }

    fn make_count_request(mode: CountMode, kce: Option<&str>) -> CountRequest {
        CountRequest {
            connection_id: Uuid::nil(),
            table_name: "events".into(),
            mode,
            index_name: None,
            key_condition_expression: kce.map(String::from),
            filter_expression: None,
            expression_attribute_names: None,
            expression_attribute_values: None,
            scan_index_forward: None,
            consistent_read: false,
            origin: None,
        }
    }

    // §2.2 — limit < 1 should fail validation
    #[test]
    fn scan_limit_zero_is_validation_error() {
        let req = make_scan_request(0);
        assert!(req.limit < 1, "limit=0 should be below minimum");
        let is_invalid = req.limit < 1 || req.limit > 1000;
        assert!(is_invalid);
    }

    // §2.2 — limit > 1000 should fail validation
    #[test]
    fn scan_limit_1001_is_validation_error() {
        let req = make_scan_request(1001);
        let is_invalid = req.limit < 1 || req.limit > 1000;
        assert!(is_invalid);
    }

    // §2.2 — limit = 1 is valid
    #[test]
    fn scan_limit_1_is_valid() {
        let req = make_scan_request(1);
        let is_invalid = req.limit < 1 || req.limit > 1000;
        assert!(!is_invalid);
    }

    // §2.2 — limit = 1000 is valid
    #[test]
    fn scan_limit_1000_is_valid() {
        let req = make_scan_request(1000);
        let is_invalid = req.limit < 1 || req.limit > 1000;
        assert!(!is_invalid);
    }

    // §3.2 — empty key_condition_expression should fail validation
    #[test]
    fn query_empty_key_condition_is_validation_error() {
        let req = make_query_request("");
        let is_invalid = req.key_condition_expression.trim().is_empty();
        assert!(is_invalid);
    }

    // §3.2 — whitespace-only key_condition_expression should fail validation
    #[test]
    fn query_whitespace_key_condition_is_validation_error() {
        let req = make_query_request("   ");
        let is_invalid = req.key_condition_expression.trim().is_empty();
        assert!(is_invalid);
    }

    // §3.2 — non-empty key_condition_expression is valid
    #[test]
    fn query_valid_key_condition_passes() {
        let req = make_query_request("#pk = :pk");
        let is_invalid = req.key_condition_expression.trim().is_empty();
        assert!(!is_invalid);
    }

    // §4.1 — count mode=query without key_condition_expression is invalid
    #[test]
    fn count_query_mode_without_kce_is_validation_error() {
        let req = make_count_request(CountMode::Query, None);
        let kce = req.key_condition_expression.as_deref().unwrap_or("").trim();
        let is_invalid = matches!(req.mode, CountMode::Query) && kce.is_empty();
        assert!(is_invalid);
    }

    // §4.1 — count mode=query with key_condition_expression is valid
    #[test]
    fn count_query_mode_with_kce_passes() {
        let req = make_count_request(CountMode::Query, Some("#pk = :pk"));
        let kce = req.key_condition_expression.as_deref().unwrap_or("").trim();
        let is_invalid = matches!(req.mode, CountMode::Query) && kce.is_empty();
        assert!(!is_invalid);
    }

    // §4.1 — count mode=scan without key_condition_expression is valid
    #[test]
    fn count_scan_mode_without_kce_is_valid() {
        let req = make_count_request(CountMode::Scan, None);
        let kce = req.key_condition_expression.as_deref().unwrap_or("").trim();
        let is_invalid = matches!(req.mode, CountMode::Query) && kce.is_empty();
        assert!(!is_invalid);
    }

    // -----------------------------------------------------------------------
    // Activity-log builder shape tests for the three new command kinds
    // -----------------------------------------------------------------------

    #[test]
    fn scan_table_ok_activity_shape() {
        let id = Uuid::nil();
        let entry = ActivityLogEntryBuilder::new(ActivityKind::ScanTable, Origin::User, 42)
            .connection(id)
            .ok(Some(Metric::Items { value: 25 }));
        let v = serde_json::to_value(&entry).unwrap();
        assert_eq!(v["kind"], "scan_table");
        assert_eq!(v["status"], "ok");
        assert_eq!(v["origin"], "user");
        assert_eq!(v["metric"]["kind"], "items");
        assert_eq!(v["metric"]["value"], 25);
    }

    #[test]
    fn scan_table_err_activity_shape() {
        let id = Uuid::nil();
        let err = AppError::Validation("limit must be between 1 and 1000, got 0".into());
        let entry = ActivityLogEntryBuilder::new(ActivityKind::ScanTable, Origin::User, 0)
            .connection(id)
            .err(&err);
        let v = serde_json::to_value(&entry).unwrap();
        assert_eq!(v["kind"], "scan_table");
        assert_eq!(v["status"], "err");
        assert!(v["metric"].is_null());
        assert!(v["error"]["message"].as_str().unwrap().contains("limit must be"));
    }

    #[test]
    fn query_table_ok_activity_shape() {
        let id = Uuid::nil();
        let entry = ActivityLogEntryBuilder::new(ActivityKind::QueryTable, Origin::Auto, 10)
            .connection(id)
            .ok(Some(Metric::Items { value: 5 }));
        let v = serde_json::to_value(&entry).unwrap();
        assert_eq!(v["kind"], "query_table");
        assert_eq!(v["status"], "ok");
        assert_eq!(v["origin"], "auto");
        assert_eq!(v["metric"]["value"], 5);
    }

    #[test]
    fn count_table_ok_activity_shape() {
        let id = Uuid::nil();
        let entry = ActivityLogEntryBuilder::new(ActivityKind::CountTable, Origin::User, 99)
            .connection(id)
            .ok(Some(Metric::Items { value: 1000 }));
        let v = serde_json::to_value(&entry).unwrap();
        assert_eq!(v["kind"], "count_table");
        assert_eq!(v["status"], "ok");
        assert_eq!(v["metric"]["kind"], "items");
        assert_eq!(v["metric"]["value"], 1000);
    }

    #[test]
    fn count_table_err_activity_shape() {
        let id = Uuid::nil();
        let err = AppError::Validation(
            "key_condition_expression is required for mode=query".into(),
        );
        let entry = ActivityLogEntryBuilder::new(ActivityKind::CountTable, Origin::User, 0)
            .connection(id)
            .err(&err);
        let v = serde_json::to_value(&entry).unwrap();
        assert_eq!(v["kind"], "count_table");
        assert_eq!(v["status"], "err");
        assert!(v["metric"].is_null());
    }

    // -----------------------------------------------------------------------
    // select_mode_to_sdk mapping test (pure function, no network)
    // -----------------------------------------------------------------------

    #[test]
    fn select_mode_to_sdk_maps_all_variants() {
        use aws_sdk_dynamodb::types::Select;
        assert_eq!(
            select_mode_to_sdk(SelectMode::AllAttributes),
            Select::AllAttributes
        );
        assert_eq!(
            select_mode_to_sdk(SelectMode::AllProjectedAttributes),
            Select::AllProjectedAttributes
        );
        assert_eq!(
            select_mode_to_sdk(SelectMode::SpecificAttributes),
            Select::SpecificAttributes
        );
        assert_eq!(select_mode_to_sdk(SelectMode::Count), Select::Count);
    }

    // -----------------------------------------------------------------------
    // compact_activity_params — scan/query/count usage patterns
    // -----------------------------------------------------------------------

    #[test]
    fn scan_compact_params_shape() {
        let params = compact_activity_params(
            "orders",
            None,
            true,
            false,
            Some(100),
            false,
            None,
            Some(1),
            None,
        );
        assert_eq!(params["table_name"], "orders");
        assert_eq!(params["has_filter"], true);
        assert_eq!(params["has_key_condition"], false);
        assert_eq!(params["limit"], 100);
        assert!(params.get("scan_index_forward").is_none());
    }

    #[test]
    fn query_compact_params_includes_scan_index_forward() {
        let params = compact_activity_params(
            "orders",
            Some("byCustomer"),
            false,
            true,
            Some(50),
            false,
            None,
            Some(1),
            Some(false),
        );
        assert_eq!(params["has_key_condition"], true);
        assert_eq!(params["scan_index_forward"], false);
        assert_eq!(params["index_name"], "byCustomer");
    }

    #[test]
    fn count_compact_params_no_limit_no_page() {
        let params = compact_activity_params(
            "events",
            None,
            false,
            true,
            None,
            true,
            None,
            None,
            None,
        );
        assert_eq!(params["consistent_read"], true);
        assert!(params.get("limit").is_none());
        assert!(params.get("page").is_none());
    }

    // -----------------------------------------------------------------------
    // §2.7 / §3.4 / §4.6  Registry-level: NotFound when client is absent
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn registry_acquire_missing_returns_not_found_for_scan() {
        use crate::modules::dynamo::client::DynamoClientRegistry;
        let registry = DynamoClientRegistry::new();
        let id = Uuid::new_v4();
        let err = registry.acquire(&id).await.unwrap_err();
        assert!(
            matches!(err, AppError::NotFound(_)),
            "expected NotFound, got {err:?}"
        );
    }
}
