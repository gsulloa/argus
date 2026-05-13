//! DynamoDB put/update/delete command plane.
//!
//! This module implements the three mutating Tauri commands for Dynamo items:
//! `dynamo_put_item`, `dynamo_update_item`, and `dynamo_delete_item`.
//! Each command enforces the read-only contract via `require_writable`, validates
//! the supplied key against the table's `KeySchema`, compiles the AWS request,
//! funnels errors through the credential-expiration helper, and emits one
//! `argus:activity-log` event before returning.

use std::collections::{BTreeMap, HashMap};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::activity_log::{
    emit_activity, ActivityKind, ActivityLogEntryBuilder, Metric, Origin,
};
use crate::modules::dynamo::client::DynamoClientRegistry;
use crate::modules::dynamo::items::{sdk_scan_err, handle_aws_err, AttrValue};
use crate::platform::DbState;

// ---------------------------------------------------------------------------
// §1.1  ReturnValues enum
// ---------------------------------------------------------------------------

/// Maps to the AWS SDK `ReturnValue` enum. Used by all three edit commands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReturnValues {
    None,
    AllOld,
    AllNew,
    UpdatedNew,
    UpdatedOld,
}

fn to_sdk_return_values(rv: ReturnValues) -> aws_sdk_dynamodb::types::ReturnValue {
    match rv {
        ReturnValues::None => aws_sdk_dynamodb::types::ReturnValue::None,
        ReturnValues::AllOld => aws_sdk_dynamodb::types::ReturnValue::AllOld,
        ReturnValues::AllNew => aws_sdk_dynamodb::types::ReturnValue::AllNew,
        ReturnValues::UpdatedNew => aws_sdk_dynamodb::types::ReturnValue::UpdatedNew,
        ReturnValues::UpdatedOld => aws_sdk_dynamodb::types::ReturnValue::UpdatedOld,
    }
}

// ---------------------------------------------------------------------------
// §1.3  cached_key_schema helper
// ---------------------------------------------------------------------------

/// Returns the attribute names in the table's KeySchema (HASH first, then RANGE if present).
///
/// Currently issues a fresh `DescribeTable` on every call.
/// TODO: cache once a crate-level describe cache exists.
async fn cached_key_schema(
    registry: &DynamoClientRegistry,
    connection_id: &Uuid,
    table_name: &str,
) -> AppResult<Vec<String>> {
    let client = registry.acquire(connection_id).await?;
    let resp = client
        .describe_table()
        .table_name(table_name)
        .send()
        .await
        .map_err(|e| sdk_scan_err(&e))?;

    let schema = resp
        .table()
        .and_then(|t| Some(t.key_schema()))
        .unwrap_or_default();

    // HASH key first, then RANGE
    let mut hash_keys: Vec<String> = schema
        .iter()
        .filter(|k| {
            k.key_type() == &aws_sdk_dynamodb::types::KeyType::Hash
        })
        .map(|k| k.attribute_name().to_string())
        .collect();

    let range_keys: Vec<String> = schema
        .iter()
        .filter(|k| {
            k.key_type() == &aws_sdk_dynamodb::types::KeyType::Range
        })
        .map(|k| k.attribute_name().to_string())
        .collect();

    hash_keys.extend(range_keys);
    Ok(hash_keys)
}

// ---------------------------------------------------------------------------
// §2  put_item
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PutItemRequest {
    pub connection_id: Uuid,
    pub table_name: String,
    pub item: HashMap<String, AttrValue>,
    pub condition_expression: Option<String>,
    pub expression_attribute_names: Option<HashMap<String, String>>,
    pub expression_attribute_values: Option<HashMap<String, AttrValue>>,
    pub return_values: Option<ReturnValues>,
    pub origin: Option<Origin>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PutItemResponse {
    pub attributes: Option<HashMap<String, AttrValue>>,
    // consumed_capacity intentionally omitted for v1 (not used by UI yet)
}

pub async fn put_item(
    app: AppHandle,
    db: State<'_, DbState>,
    registry: State<'_, DynamoClientRegistry>,
    req: PutItemRequest,
) -> AppResult<PutItemResponse> {
    let origin = req.origin.unwrap_or_default();
    let started = Instant::now();

    let params_json = serde_json::json!({
        "table_name": req.table_name,
        "has_condition": req.condition_expression.is_some(),
        "num_attributes": req.item.len() as u32,
    });

    // Step 1: require_writable — reject before any AWS call
    if let Err(e) = registry.require_writable(&req.connection_id).await {
        let duration_ms = started.elapsed().as_millis() as u64;
        emit_activity(
            &app,
            ActivityLogEntryBuilder::new(ActivityKind::PutItem, origin, duration_ms)
                .connection(req.connection_id)
                .params(vec![params_json.to_string()])
                .err(&e),
        );
        return Err(e);
    }

    // Step 2: validate key attributes present in item
    let key_schema = match cached_key_schema(&registry, &req.connection_id, &req.table_name).await {
        Ok(ks) => ks,
        Err(e) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::PutItem, origin, duration_ms)
                    .connection(req.connection_id)
                    .params(vec![params_json.to_string()])
                    .err(&e),
            );
            return Err(e);
        }
    };

    let missing: Vec<&str> = key_schema
        .iter()
        .filter(|k| !req.item.contains_key(k.as_str()))
        .map(|k| k.as_str())
        .collect();

    if !missing.is_empty() {
        let e = AppError::Validation(format!("item is missing key attributes: {missing:?}"));
        let duration_ms = started.elapsed().as_millis() as u64;
        emit_activity(
            &app,
            ActivityLogEntryBuilder::new(ActivityKind::PutItem, origin, duration_ms)
                .connection(req.connection_id)
                .params(vec![params_json.to_string()])
                .err(&e),
        );
        return Err(e);
    }

    // Step 3: acquire client and build SDK request
    let client = registry.acquire(&req.connection_id).await?;

    let mut builder = client.put_item().table_name(&req.table_name);

    for (k, v) in &req.item {
        builder = builder.item(k, v.clone().into());
    }

    if let Some(ce) = &req.condition_expression {
        builder = builder.condition_expression(ce);
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
    if let Some(rv) = req.return_values {
        builder = builder.return_values(to_sdk_return_values(rv));
    }

    let result = builder.send().await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(resp) => {
            let attributes = resp
                .attributes()
                .filter(|m| !m.is_empty())
                .map(|m| {
                    m.iter()
                        .map(|(k, v)| (k.clone(), AttrValue::from(v.clone())))
                        .collect()
                });

            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::PutItem, origin, duration_ms)
                    .connection(req.connection_id)
                    .params(vec![params_json.to_string()])
                    .ok(Some(Metric::Items { value: 1 })),
            );

            Ok(PutItemResponse { attributes })
        }
        Err(e) => {
            let app_err = sdk_scan_err(&e);
            let app_err = handle_aws_err(&db, &registry, &req.connection_id, app_err).await;
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::PutItem, origin, duration_ms)
                    .connection(req.connection_id)
                    .params(vec![params_json.to_string()])
                    .err(&app_err),
            );
            Err(app_err)
        }
    }
}

#[tauri::command]
pub async fn dynamo_put_item(
    app: AppHandle,
    db: State<'_, DbState>,
    registry: State<'_, DynamoClientRegistry>,
    req: PutItemRequest,
) -> AppResult<PutItemResponse> {
    put_item(app, db, registry, req).await
}

// ---------------------------------------------------------------------------
// §3  update_item + UpdateExpression compiler
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct UpdateOps {
    #[serde(default)]
    pub set: HashMap<String, AttrValue>,
    #[serde(default)]
    pub remove: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct UpdateItemRequest {
    pub connection_id: Uuid,
    pub table_name: String,
    pub key: HashMap<String, AttrValue>,
    pub updates: UpdateOps,
    pub condition_expression: Option<String>,
    pub expression_attribute_names: Option<HashMap<String, String>>,
    pub expression_attribute_values: Option<HashMap<String, AttrValue>>,
    pub return_values: Option<ReturnValues>,
    pub origin: Option<Origin>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateItemResponse {
    pub attributes: Option<HashMap<String, AttrValue>>,
}

/// Compile `UpdateOps` into a canonical `UpdateExpression` with auto-generated
/// `#n<idx>` / `:v<idx>` placeholders that do NOT collide with caller-supplied
/// `expression_attribute_names` / `expression_attribute_values`.
///
/// Returns `(expression, merged_names, merged_values)`.
///
/// Walk order: SET entries sorted by key (via BTreeMap) for determinism; REMOVE
/// entries in their original order.
/// Allocate a fresh `#n<i>` placeholder that doesn't exist in `names`.
fn alloc_name_placeholder(names: &HashMap<String, String>, hint: &mut usize) -> String {
    loop {
        let candidate = format!("#n{}", hint);
        *hint += 1;
        if !names.contains_key(&candidate) {
            return candidate;
        }
    }
}

/// Allocate a fresh `:v<i>` placeholder that doesn't exist in `values`.
fn alloc_value_placeholder(
    values: &HashMap<String, AttrValue>,
    hint: &mut usize,
) -> String {
    loop {
        let candidate = format!(":v{}", hint);
        *hint += 1;
        if !values.contains_key(&candidate) {
            return candidate;
        }
    }
}

pub fn compile_update_expression(
    updates: &UpdateOps,
    caller_names: Option<&HashMap<String, String>>,
    caller_values: Option<&HashMap<String, AttrValue>>,
) -> (String, HashMap<String, String>, HashMap<String, AttrValue>) {
    let mut merged_names: HashMap<String, String> =
        caller_names.cloned().unwrap_or_default();
    let mut merged_values: HashMap<String, AttrValue> =
        caller_values.cloned().unwrap_or_default();

    let mut set_parts: Vec<String> = Vec::new();
    let mut remove_parts: Vec<String> = Vec::new();
    let mut name_idx: usize = 0;
    let mut val_idx: usize = 0;

    // SET entries: sorted by key for determinism
    let set_sorted: BTreeMap<&String, &AttrValue> = updates.set.iter().collect();
    for (attr_name, attr_val) in &set_sorted {
        let name_ph = alloc_name_placeholder(&merged_names, &mut name_idx);
        let val_ph = alloc_value_placeholder(&merged_values, &mut val_idx);
        merged_names.insert(name_ph.clone(), attr_name.to_string());
        merged_values.insert(val_ph.clone(), (*attr_val).clone());
        set_parts.push(format!("{name_ph} = {val_ph}"));
    }

    // REMOVE entries: in their original order
    for attr_name in &updates.remove {
        let name_ph = alloc_name_placeholder(&merged_names, &mut name_idx);
        merged_names.insert(name_ph.clone(), attr_name.clone());
        remove_parts.push(name_ph);
    }

    let mut expression = String::new();
    if !set_parts.is_empty() {
        expression.push_str("SET ");
        expression.push_str(&set_parts.join(", "));
    }
    if !remove_parts.is_empty() {
        if !expression.is_empty() {
            expression.push(' ');
        }
        expression.push_str("REMOVE ");
        expression.push_str(&remove_parts.join(", "));
    }

    (expression, merged_names, merged_values)
}

/// Pure validation helper — returns Err(AppError::Validation) if the update is invalid.
/// Extracted as a pure fn so it can be unit-tested without async/AWS.
pub fn validate_update_request(
    key: &HashMap<String, AttrValue>,
    updates: &UpdateOps,
    key_schema: &[String],
) -> AppResult<()> {
    // key must be non-empty
    if key.is_empty() {
        return Err(AppError::Validation("key must not be empty".to_string()));
    }

    // key must match key_schema exactly
    let mut schema_sorted: Vec<&str> = key_schema.iter().map(|s| s.as_str()).collect();
    schema_sorted.sort_unstable();
    let mut key_sorted: Vec<&str> = key.keys().map(|s| s.as_str()).collect();
    key_sorted.sort_unstable();

    if schema_sorted != key_sorted {
        let missing: Vec<&str> = schema_sorted
            .iter()
            .filter(|k| !key.contains_key(**k))
            .copied()
            .collect();
        let extra: Vec<&str> = key_sorted
            .iter()
            .filter(|k| !key_schema.iter().any(|s| s.as_str() == **k))
            .copied()
            .collect();
        let mut msg = String::from("key does not match KeySchema");
        if !missing.is_empty() {
            msg.push_str(&format!("; missing: {missing:?}"));
        }
        if !extra.is_empty() {
            msg.push_str(&format!("; extra: {extra:?}"));
        }
        return Err(AppError::Validation(msg));
    }

    // at least one update must be present
    if updates.set.is_empty() && updates.remove.is_empty() {
        return Err(AppError::Validation(
            "updates must contain at least one set or remove entry".to_string(),
        ));
    }

    // no overlap between set keys and remove entries
    for k in updates.set.keys() {
        if updates.remove.contains(k) {
            return Err(AppError::Validation(format!(
                "attribute '{k}' appears in both set and remove"
            )));
        }
    }

    // no set or remove entry may name a KeySchema attribute
    for k in updates.set.keys() {
        if key_schema.contains(k) {
            return Err(AppError::Validation(format!(
                "key attribute '{k}' cannot be mutated in place via update_item"
            )));
        }
    }
    for k in &updates.remove {
        if key_schema.contains(k) {
            return Err(AppError::Validation(format!(
                "key attribute '{k}' cannot be removed via update_item"
            )));
        }
    }

    Ok(())
}

pub async fn update_item(
    app: AppHandle,
    db: State<'_, DbState>,
    registry: State<'_, DynamoClientRegistry>,
    req: UpdateItemRequest,
) -> AppResult<UpdateItemResponse> {
    let origin = req.origin.unwrap_or_default();
    let started = Instant::now();

    let params_json = serde_json::json!({
        "table_name": req.table_name,
        "has_condition": req.condition_expression.is_some(),
        "num_set": req.updates.set.len() as u32,
        "num_remove": req.updates.remove.len() as u32,
    });

    // Step 1: require_writable
    if let Err(e) = registry.require_writable(&req.connection_id).await {
        let duration_ms = started.elapsed().as_millis() as u64;
        emit_activity(
            &app,
            ActivityLogEntryBuilder::new(ActivityKind::UpdateItem, origin, duration_ms)
                .connection(req.connection_id)
                .params(vec![params_json.to_string()])
                .err(&e),
        );
        return Err(e);
    }

    // Step 2: fetch key schema
    let key_schema =
        match cached_key_schema(&registry, &req.connection_id, &req.table_name).await {
            Ok(ks) => ks,
            Err(e) => {
                let duration_ms = started.elapsed().as_millis() as u64;
                emit_activity(
                    &app,
                    ActivityLogEntryBuilder::new(ActivityKind::UpdateItem, origin, duration_ms)
                        .connection(req.connection_id)
                        .params(vec![params_json.to_string()])
                        .err(&e),
                );
                return Err(e);
            }
        };

    // Step 3: validate
    if let Err(e) = validate_update_request(&req.key, &req.updates, &key_schema) {
        let duration_ms = started.elapsed().as_millis() as u64;
        emit_activity(
            &app,
            ActivityLogEntryBuilder::new(ActivityKind::UpdateItem, origin, duration_ms)
                .connection(req.connection_id)
                .params(vec![params_json.to_string()])
                .err(&e),
        );
        return Err(e);
    }

    // Step 4: compile update expression
    let (expression, merged_names, merged_values) = compile_update_expression(
        &req.updates,
        req.expression_attribute_names.as_ref(),
        req.expression_attribute_values.as_ref(),
    );

    // Step 5: acquire client and build SDK request
    let client = registry.acquire(&req.connection_id).await?;

    let mut builder = client
        .update_item()
        .table_name(&req.table_name)
        .update_expression(&expression)
        .set_expression_attribute_names(Some(merged_names))
        .set_expression_attribute_values(Some(
            merged_values
                .into_iter()
                .map(|(k, v)| (k, v.into()))
                .collect::<HashMap<_, _>>(),
        ));

    if let Some(ce) = &req.condition_expression {
        builder = builder.condition_expression(ce);
    }

    for (k, v) in &req.key {
        builder = builder.key(k, v.clone().into());
    }

    // default return_values is ALL_NEW
    let rv = req.return_values.unwrap_or(ReturnValues::AllNew);
    builder = builder.return_values(to_sdk_return_values(rv));

    let result = builder.send().await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(resp) => {
            let attributes = resp
                .attributes()
                .filter(|m| !m.is_empty())
                .map(|m| {
                    m.iter()
                        .map(|(k, v)| (k.clone(), AttrValue::from(v.clone())))
                        .collect()
                });

            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::UpdateItem, origin, duration_ms)
                    .connection(req.connection_id)
                    .params(vec![params_json.to_string()])
                    .ok(Some(Metric::Items { value: 1 })),
            );

            Ok(UpdateItemResponse { attributes })
        }
        Err(e) => {
            let app_err = sdk_scan_err(&e);
            let app_err = handle_aws_err(&db, &registry, &req.connection_id, app_err).await;
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::UpdateItem, origin, duration_ms)
                    .connection(req.connection_id)
                    .params(vec![params_json.to_string()])
                    .err(&app_err),
            );
            Err(app_err)
        }
    }
}

#[tauri::command]
pub async fn dynamo_update_item(
    app: AppHandle,
    db: State<'_, DbState>,
    registry: State<'_, DynamoClientRegistry>,
    req: UpdateItemRequest,
) -> AppResult<UpdateItemResponse> {
    update_item(app, db, registry, req).await
}

// ---------------------------------------------------------------------------
// §4  delete_item
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DeleteItemRequest {
    pub connection_id: Uuid,
    pub table_name: String,
    pub key: HashMap<String, AttrValue>,
    pub condition_expression: Option<String>,
    pub expression_attribute_names: Option<HashMap<String, String>>,
    pub expression_attribute_values: Option<HashMap<String, AttrValue>>,
    pub return_values: Option<ReturnValues>,
    pub origin: Option<Origin>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeleteItemResponse {
    pub attributes: Option<HashMap<String, AttrValue>>,
}

/// Pure validation helper for delete key.
pub fn validate_delete_key(
    key: &HashMap<String, AttrValue>,
    key_schema: &[String],
) -> AppResult<()> {
    if key.is_empty() {
        return Err(AppError::Validation("key must not be empty".to_string()));
    }

    let mut schema_sorted: Vec<&str> = key_schema.iter().map(|s| s.as_str()).collect();
    schema_sorted.sort_unstable();
    let mut key_sorted: Vec<&str> = key.keys().map(|s| s.as_str()).collect();
    key_sorted.sort_unstable();

    if schema_sorted != key_sorted {
        let missing: Vec<&str> = schema_sorted
            .iter()
            .filter(|k| !key.contains_key(**k))
            .copied()
            .collect();
        let extra: Vec<&str> = key_sorted
            .iter()
            .filter(|k| !key_schema.iter().any(|s| s.as_str() == **k))
            .copied()
            .collect();
        let mut msg = String::from("key does not match KeySchema");
        if !missing.is_empty() {
            msg.push_str(&format!("; missing: {missing:?}"));
        }
        if !extra.is_empty() {
            msg.push_str(&format!("; extra: {extra:?}"));
        }
        return Err(AppError::Validation(msg));
    }

    Ok(())
}

pub async fn delete_item(
    app: AppHandle,
    db: State<'_, DbState>,
    registry: State<'_, DynamoClientRegistry>,
    req: DeleteItemRequest,
) -> AppResult<DeleteItemResponse> {
    let origin = req.origin.unwrap_or_default();
    let started = Instant::now();

    let params_json = serde_json::json!({
        "table_name": req.table_name,
        "has_condition": req.condition_expression.is_some(),
    });

    // Step 1: require_writable
    if let Err(e) = registry.require_writable(&req.connection_id).await {
        let duration_ms = started.elapsed().as_millis() as u64;
        emit_activity(
            &app,
            ActivityLogEntryBuilder::new(ActivityKind::DeleteItem, origin, duration_ms)
                .connection(req.connection_id)
                .params(vec![params_json.to_string()])
                .err(&e),
        );
        return Err(e);
    }

    // Step 2: fetch key schema
    let key_schema =
        match cached_key_schema(&registry, &req.connection_id, &req.table_name).await {
            Ok(ks) => ks,
            Err(e) => {
                let duration_ms = started.elapsed().as_millis() as u64;
                emit_activity(
                    &app,
                    ActivityLogEntryBuilder::new(ActivityKind::DeleteItem, origin, duration_ms)
                        .connection(req.connection_id)
                        .params(vec![params_json.to_string()])
                        .err(&e),
                );
                return Err(e);
            }
        };

    // Step 3: validate key
    if let Err(e) = validate_delete_key(&req.key, &key_schema) {
        let duration_ms = started.elapsed().as_millis() as u64;
        emit_activity(
            &app,
            ActivityLogEntryBuilder::new(ActivityKind::DeleteItem, origin, duration_ms)
                .connection(req.connection_id)
                .params(vec![params_json.to_string()])
                .err(&e),
        );
        return Err(e);
    }

    // Step 4: acquire client and build SDK request
    let client = registry.acquire(&req.connection_id).await?;

    let mut builder = client.delete_item().table_name(&req.table_name);

    for (k, v) in &req.key {
        builder = builder.key(k, v.clone().into());
    }

    if let Some(ce) = &req.condition_expression {
        builder = builder.condition_expression(ce);
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
    // Only apply return_values if caller explicitly requests it (default = NONE / omitted)
    if let Some(rv) = req.return_values {
        builder = builder.return_values(to_sdk_return_values(rv));
    }

    let result = builder.send().await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(resp) => {
            let attributes = resp
                .attributes()
                .filter(|m| !m.is_empty())
                .map(|m| {
                    m.iter()
                        .map(|(k, v)| (k.clone(), AttrValue::from(v.clone())))
                        .collect()
                });

            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::DeleteItem, origin, duration_ms)
                    .connection(req.connection_id)
                    .params(vec![params_json.to_string()])
                    .ok(Some(Metric::Items { value: 1 })),
            );

            Ok(DeleteItemResponse { attributes })
        }
        Err(e) => {
            let app_err = sdk_scan_err(&e);
            let app_err = handle_aws_err(&db, &registry, &req.connection_id, app_err).await;
            emit_activity(
                &app,
                ActivityLogEntryBuilder::new(ActivityKind::DeleteItem, origin, duration_ms)
                    .connection(req.connection_id)
                    .params(vec![params_json.to_string()])
                    .err(&app_err),
            );
            Err(app_err)
        }
    }
}

#[tauri::command]
pub async fn dynamo_delete_item(
    app: AppHandle,
    db: State<'_, DbState>,
    registry: State<'_, DynamoClientRegistry>,
    req: DeleteItemRequest,
) -> AppResult<DeleteItemResponse> {
    delete_item(app, db, registry, req).await
}

// ---------------------------------------------------------------------------
// §2.7 / §3.8 / §3.9 / §4.6  Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // §3.8  compile_update_expression — pure compiler tests
    // -----------------------------------------------------------------------

    #[test]
    fn compile_set_only_two_entries() {
        let mut set = HashMap::new();
        set.insert("status".to_string(), AttrValue::S("ok".to_string()));
        set.insert("count".to_string(), AttrValue::N("5".to_string()));
        let updates = UpdateOps {
            set,
            remove: vec![],
        };
        let (expr, names, values) =
            compile_update_expression(&updates, None, None);

        // Must start with SET
        assert!(expr.starts_with("SET "), "expr: {expr}");
        // Must not contain REMOVE
        assert!(!expr.contains("REMOVE"), "expr: {expr}");
        // Should have 2 name entries and 2 value entries
        assert_eq!(names.len(), 2);
        assert_eq!(values.len(), 2);
        // Names should map to status and count (in sorted order: count, status)
        let name_vals: std::collections::HashSet<String> = names.values().cloned().collect();
        assert!(name_vals.contains("status"));
        assert!(name_vals.contains("count"));
    }

    #[test]
    fn compile_remove_only_two_entries() {
        let updates = UpdateOps {
            set: HashMap::new(),
            remove: vec!["archived".to_string(), "legacy".to_string()],
        };
        let (expr, names, values) =
            compile_update_expression(&updates, None, None);

        assert!(expr.starts_with("REMOVE "), "expr: {expr}");
        assert!(!expr.contains("SET"), "expr: {expr}");
        assert_eq!(names.len(), 2);
        assert!(values.is_empty());
        let name_vals: std::collections::HashSet<String> = names.values().cloned().collect();
        assert!(name_vals.contains("archived"));
        assert!(name_vals.contains("legacy"));
    }

    #[test]
    fn compile_set_and_remove() {
        let mut set = HashMap::new();
        set.insert("status".to_string(), AttrValue::S("ok".to_string()));
        let updates = UpdateOps {
            set,
            remove: vec!["archived".to_string()],
        };
        let (expr, names, values) =
            compile_update_expression(&updates, None, None);

        assert!(expr.contains("SET "), "expr: {expr}");
        assert!(expr.contains(" REMOVE "), "expr: {expr}");
        // SET must come before REMOVE
        assert!(
            expr.find("SET").unwrap() < expr.find("REMOVE").unwrap(),
            "SET must precede REMOVE in: {expr}"
        );
        assert_eq!(names.len(), 2); // one for set attr + one for remove attr
        assert_eq!(values.len(), 1); // only set has a value
    }

    #[test]
    fn compile_caller_collision_shifts_index() {
        // Caller already has #n0 and :v0
        let mut caller_names = HashMap::new();
        caller_names.insert("#n0".to_string(), "version".to_string());
        let mut caller_values = HashMap::new();
        caller_values.insert(":v0".to_string(), AttrValue::N("3".to_string()));

        let mut set = HashMap::new();
        set.insert("status".to_string(), AttrValue::S("ok".to_string()));
        let updates = UpdateOps {
            set,
            remove: vec![],
        };
        let (expr, names, values) = compile_update_expression(
            &updates,
            Some(&caller_names),
            Some(&caller_values),
        );

        // The compiler must NOT use #n0 or :v0 for the new attribute
        // (those are reserved by the caller)
        assert!(!expr.contains("#n0 ="), "must not overwrite caller #n0; expr: {expr}");
        // The generated SET expression must use #n1 or higher
        assert!(
            expr.contains("#n1") || expr.contains("#n2"),
            "should use #n1+ to avoid collision; expr: {expr}"
        );
        // Caller entries must still be in the merged maps
        assert_eq!(names.get("#n0"), Some(&"version".to_string()));
        assert!(values.contains_key(":v0"));
    }

    // -----------------------------------------------------------------------
    // §3.9  validate_update_request — pure validation tests
    // -----------------------------------------------------------------------

    fn make_key(pk: &str) -> HashMap<String, AttrValue> {
        let mut m = HashMap::new();
        m.insert("pk".to_string(), AttrValue::S(pk.to_string()));
        m
    }

    fn make_key_composite(pk: &str, sk: &str) -> HashMap<String, AttrValue> {
        let mut m = HashMap::new();
        m.insert("pk".to_string(), AttrValue::S(pk.to_string()));
        m.insert("sk".to_string(), AttrValue::S(sk.to_string()));
        m
    }

    #[test]
    fn validate_update_empty_key_rejected() {
        let updates = UpdateOps {
            set: {
                let mut m = HashMap::new();
                m.insert("status".to_string(), AttrValue::S("ok".to_string()));
                m
            },
            remove: vec![],
        };
        let err = validate_update_request(&HashMap::new(), &updates, &["pk".to_string()])
            .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn validate_update_missing_key_attr_rejected() {
        // key only has pk; schema requires pk + sk
        let key = make_key("user-1");
        let updates = UpdateOps {
            set: {
                let mut m = HashMap::new();
                m.insert("status".to_string(), AttrValue::S("ok".to_string()));
                m
            },
            remove: vec![],
        };
        let schema = vec!["pk".to_string(), "sk".to_string()];
        let err = validate_update_request(&key, &updates, &schema).unwrap_err();
        match &err {
            AppError::Validation(msg) => {
                assert!(msg.contains("sk"), "should mention missing 'sk': {msg}");
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[test]
    fn validate_update_empty_updates_rejected() {
        let key = make_key_composite("user-1", "evt-1");
        let updates = UpdateOps {
            set: HashMap::new(),
            remove: vec![],
        };
        let schema = vec!["pk".to_string(), "sk".to_string()];
        let err = validate_update_request(&key, &updates, &schema).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn validate_update_overlap_set_remove_rejected() {
        let key = make_key_composite("user-1", "evt-1");
        let updates = UpdateOps {
            set: {
                let mut m = HashMap::new();
                m.insert("status".to_string(), AttrValue::S("ok".to_string()));
                m
            },
            remove: vec!["status".to_string()],
        };
        let schema = vec!["pk".to_string(), "sk".to_string()];
        let err = validate_update_request(&key, &updates, &schema).unwrap_err();
        match &err {
            AppError::Validation(msg) => {
                assert!(msg.contains("status"), "should mention 'status': {msg}");
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[test]
    fn validate_update_set_key_attr_rejected() {
        let key = make_key_composite("user-1", "evt-1");
        let updates = UpdateOps {
            set: {
                let mut m = HashMap::new();
                m.insert("pk".to_string(), AttrValue::S("new-user".to_string()));
                m
            },
            remove: vec![],
        };
        let schema = vec!["pk".to_string(), "sk".to_string()];
        let err = validate_update_request(&key, &updates, &schema).unwrap_err();
        match &err {
            AppError::Validation(msg) => {
                assert!(
                    msg.contains("pk"),
                    "should mention key attribute 'pk': {msg}"
                );
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[test]
    fn validate_update_remove_key_attr_rejected() {
        let key = make_key_composite("user-1", "evt-1");
        let updates = UpdateOps {
            set: HashMap::new(),
            remove: vec!["sk".to_string()],
        };
        let schema = vec!["pk".to_string(), "sk".to_string()];
        let err = validate_update_request(&key, &updates, &schema).unwrap_err();
        match &err {
            AppError::Validation(msg) => {
                assert!(
                    msg.contains("sk"),
                    "should mention key attribute 'sk': {msg}"
                );
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------------
    // §2.7 / §4.6  validate_delete_key — validation tests
    // -----------------------------------------------------------------------

    #[test]
    fn validate_delete_missing_sk_rejected() {
        let key = make_key("user-1");
        let schema = vec!["pk".to_string(), "sk".to_string()];
        let err = validate_delete_key(&key, &schema).unwrap_err();
        match &err {
            AppError::Validation(msg) => {
                assert!(msg.contains("sk"), "should name missing 'sk': {msg}");
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[test]
    fn validate_delete_empty_key_rejected() {
        let schema = vec!["pk".to_string()];
        let err = validate_delete_key(&HashMap::new(), &schema).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    // -----------------------------------------------------------------------
    // §2.7 / §4.6  require_writable tests (async, uses real DynamoClientRegistry)
    // -----------------------------------------------------------------------

    use crate::modules::dynamo::client::ActiveDynamoClient;

    fn make_test_client_inner(region: &str) -> aws_sdk_dynamodb::Client {
        use aws_sdk_dynamodb::config::{BehaviorVersion, Credentials, Region};
        let config = aws_sdk_dynamodb::Config::builder()
            .region(Region::new(region.to_string()))
            .credentials_provider(Credentials::new("AKIATEST", "secret", None, None, "test"))
            .behavior_version(BehaviorVersion::latest())
            .build();
        aws_sdk_dynamodb::Client::from_conf(config)
    }

    fn make_active_client(read_only: bool) -> ActiveDynamoClient {
        ActiveDynamoClient {
            client: make_test_client_inner("us-east-1"),
            account_id: "123456789012".into(),
            identity_arn: "arn:aws:iam::123456789012:user/test".into(),
            region: "us-east-1".into(),
            read_only,
            connected_at_unix_ms: 0,
        }
    }

    #[tokio::test]
    async fn read_only_connection_rejects_require_writable() {
        let registry = DynamoClientRegistry::new();
        let id = Uuid::new_v4();
        registry.insert(id, make_active_client(true)).await;
        let err = registry.require_writable(&id).await.unwrap_err();
        assert!(
            matches!(&err, AppError::Validation(msg) if msg.contains("read-only")),
            "expected Validation with 'read-only', got {err:?}"
        );
    }

    #[tokio::test]
    async fn unknown_connection_id_returns_not_found() {
        let registry = DynamoClientRegistry::new();
        let id = Uuid::new_v4();
        let err = registry.require_writable(&id).await.unwrap_err();
        assert!(
            matches!(err, AppError::NotFound(_)),
            "expected NotFound, got {err:?}"
        );
    }

    // Note: ConditionalCheckFailed and ExpiredToken funnel tests at the command
    // level require AWS responses and are therefore not unit-tested here.
    // Those code paths are exercised by sdk_scan_err + handle_aws_err which are
    // tested in client.rs and items.rs respectively.
}
