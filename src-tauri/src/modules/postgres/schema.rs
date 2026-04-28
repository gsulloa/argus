use deadpool_postgres::Object as PgObject;
use tokio_postgres::error::SqlState;

use crate::error::{AppError, AppResult};
use crate::modules::postgres::pool::PgPoolRegistry;
use crate::modules::postgres::schema_types::{
    ExtensionInfo, FunctionInfo, IndexInfo, SchemaObjects, SchemaSummary, TableInfo, TableKind,
    TriggerEvent, TriggerInfo, TriggerTiming, TypeInfo, TypeKind, ViewInfo,
};

const SQL_LIST_SCHEMAS: &str = "\
SELECT n.nspname,
       pg_catalog.pg_get_userbyid(n.nspowner),
       (n.nspname LIKE 'pg\\_%' ESCAPE '\\' OR n.nspname = 'information_schema'),
       d.description
FROM pg_catalog.pg_namespace n
LEFT JOIN pg_catalog.pg_description d
       ON d.objoid = n.oid AND d.objsubid = 0 AND d.classoid = 'pg_namespace'::regclass
ORDER BY 3, 1";

/// Single UNION-ALL-style query covering all five "data" relkinds:
/// regular table (r), partitioned table (p), foreign table (f),
/// view (v), materialized view (m). Replaces the three separate queries
/// that the first cut of the schema browser used.
const SQL_LIST_DATA: &str = "\
SELECT c.relkind::text,
       c.relname,
       pg_catalog.pg_get_userbyid(c.relowner),
       c.reltuples::bigint,
       d.description
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_description d
       ON d.objoid = c.oid AND d.objsubid = 0 AND d.classoid = 'pg_class'::regclass
WHERE n.nspname = $1
  AND c.relkind IN ('r','p','f','v','m')
ORDER BY c.relname";

const SQL_LIST_FUNCTIONS: &str = "\
SELECT p.proname,
       pg_catalog.pg_get_function_arguments(p.oid),
       pg_catalog.pg_get_function_result(p.oid),
       l.lanname,
       d.description
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
JOIN pg_catalog.pg_language l ON l.oid = p.prolang
LEFT JOIN pg_catalog.pg_description d
       ON d.objoid = p.oid AND d.objsubid = 0 AND d.classoid = 'pg_proc'::regclass
WHERE n.nspname = $1
  AND p.prokind = 'f'
ORDER BY p.proname, 2";

const SQL_LIST_TYPES: &str = "\
SELECT t.typname,
       t.typtype::text,
       d.description
FROM pg_catalog.pg_type t
JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
LEFT JOIN pg_catalog.pg_description d
       ON d.objoid = t.oid AND d.objsubid = 0 AND d.classoid = 'pg_type'::regclass
WHERE n.nspname = $1
  AND t.typtype IN ('c','e','d','r')
  AND (
    t.typtype <> 'c'
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid = t.typrelid AND c.relkind = 'c'
    )
  )
ORDER BY t.typname";

const SQL_LIST_EXTENSIONS: &str = "\
SELECT e.extname,
       e.extversion,
       d.description
FROM pg_catalog.pg_extension e
JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
LEFT JOIN pg_catalog.pg_description d
       ON d.objoid = e.oid AND d.objsubid = 0 AND d.classoid = 'pg_extension'::regclass
WHERE n.nspname = $1
ORDER BY e.extname";

const SQL_LIST_INDEXES: &str = "\
SELECT i.relname,
       t.relname,
       ix.indisunique,
       ix.indisprimary,
       am.amname
FROM pg_catalog.pg_index ix
JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
JOIN pg_catalog.pg_namespace n ON n.oid = i.relnamespace
JOIN pg_catalog.pg_am am ON am.oid = i.relam
WHERE n.nspname = $1
ORDER BY t.relname, i.relname";

const SQL_LIST_TRIGGERS: &str = "\
SELECT t.tgname,
       c.relname,
       t.tgtype,
       p.proname || '(' || pg_catalog.pg_get_function_arguments(p.oid) || ')'
FROM pg_catalog.pg_trigger t
JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
WHERE n.nspname = $1
  AND NOT t.tgisinternal
ORDER BY c.relname, t.tgname";

// Trigger type bitmask (from PG sources, src/include/catalog/pg_trigger.h):
const TRIGGER_TYPE_BEFORE: i32 = 1 << 1;
const TRIGGER_TYPE_INSERT: i32 = 1 << 2;
const TRIGGER_TYPE_DELETE: i32 = 1 << 3;
const TRIGGER_TYPE_UPDATE: i32 = 1 << 4;
const TRIGGER_TYPE_TRUNCATE: i32 = 1 << 5;
const TRIGGER_TYPE_INSTEAD: i32 = 1 << 6;

fn decode_trigger_timing(tgtype: i32) -> TriggerTiming {
    if tgtype & TRIGGER_TYPE_INSTEAD != 0 {
        TriggerTiming::InsteadOf
    } else if tgtype & TRIGGER_TYPE_BEFORE != 0 {
        TriggerTiming::Before
    } else {
        TriggerTiming::After
    }
}

fn decode_trigger_events(tgtype: i32) -> Vec<TriggerEvent> {
    let mut out = Vec::with_capacity(4);
    if tgtype & TRIGGER_TYPE_INSERT != 0 {
        out.push(TriggerEvent::Insert);
    }
    if tgtype & TRIGGER_TYPE_UPDATE != 0 {
        out.push(TriggerEvent::Update);
    }
    if tgtype & TRIGGER_TYPE_DELETE != 0 {
        out.push(TriggerEvent::Delete);
    }
    if tgtype & TRIGGER_TYPE_TRUNCATE != 0 {
        out.push(TriggerEvent::Truncate);
    }
    out
}

fn map_table_kind(rk: &str) -> TableKind {
    match rk {
        "p" => TableKind::Partitioned,
        "f" => TableKind::Foreign,
        _ => TableKind::Regular,
    }
}

fn map_type_kind(tt: &str) -> Option<TypeKind> {
    match tt {
        "c" => Some(TypeKind::Composite),
        "e" => Some(TypeKind::Enum),
        "d" => Some(TypeKind::Domain),
        "r" => Some(TypeKind::Range),
        _ => None,
    }
}

/// Returns true if the error is a "permission denied" Postgres error (SQLSTATE 42501).
fn is_permission_denied(err: &AppError) -> bool {
    if let AppError::Postgres(body) = err {
        if let Some(code) = &body.code {
            return code == SqlState::INSUFFICIENT_PRIVILEGE.code();
        }
    }
    false
}

/// Wrap a kind-specific query: on permission-denied, return an empty Vec and warn.
async fn try_kind<T, F, Fut>(kind: &'static str, schema: &str, f: F) -> AppResult<Vec<T>>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = AppResult<Vec<T>>>,
{
    match f().await {
        Ok(v) => Ok(v),
        Err(e) if is_permission_denied(&e) => {
            tracing::warn!(
                "schema browser: permission denied listing {kind} in schema {schema}: {e}"
            );
            Ok(Vec::new())
        }
        Err(e) => Err(e),
    }
}

pub async fn list_schemas(client: &PgObject) -> AppResult<Vec<SchemaSummary>> {
    let rows = client.query(SQL_LIST_SCHEMAS, &[]).await?;
    Ok(rows
        .into_iter()
        .map(|r| SchemaSummary {
            name: r.get::<_, String>(0),
            owner: r.get::<_, Option<String>>(1),
            is_system: r.get::<_, bool>(2),
            comment: r.get::<_, Option<String>>(3),
        })
        .collect())
}

/// Run the unified data query and split the rows into the typed buckets on
/// `SchemaObjects` based on the relkind text column. Permission-denied at this
/// layer surfaces as an error: a user that cannot see `pg_class` cannot
/// browse the schema at all.
async fn fetch_data(
    client: &PgObject,
    schema: &str,
    out: &mut SchemaObjects,
) -> AppResult<()> {
    let rows = client.query(SQL_LIST_DATA, &[&schema]).await?;
    for r in rows {
        let relkind: String = r.get(0);
        let name: String = r.get(1);
        let owner: Option<String> = r.get(2);
        let estimated_rows: Option<i64> = r.get(3);
        let comment: Option<String> = r.get(4);
        match relkind.as_str() {
            "r" | "p" | "f" => {
                out.tables.push(TableInfo {
                    name,
                    owner,
                    estimated_rows,
                    comment,
                    kind: map_table_kind(&relkind),
                });
            }
            "v" => {
                out.views.push(ViewInfo {
                    name,
                    owner,
                    comment,
                });
            }
            "m" => {
                out.materialized_views.push(ViewInfo {
                    name,
                    owner,
                    comment,
                });
            }
            _ => {
                // Should never hit — the SQL filter is exhaustive — but stay
                // defensive in case the catalog grows new relkinds.
                tracing::warn!("schema browser: unexpected relkind '{relkind}' for {name}");
            }
        }
    }
    Ok(())
}

async fn list_functions(client: &PgObject, schema: &str) -> AppResult<Vec<FunctionInfo>> {
    let rows = client.query(SQL_LIST_FUNCTIONS, &[&schema]).await?;
    Ok(rows
        .into_iter()
        .map(|r| FunctionInfo {
            name: r.get::<_, String>(0),
            args_signature: r.get::<_, String>(1),
            return_type: r.get::<_, Option<String>>(2),
            language: r.get::<_, String>(3),
            comment: r.get::<_, Option<String>>(4),
        })
        .collect())
}

async fn list_types(client: &PgObject, schema: &str) -> AppResult<Vec<TypeInfo>> {
    let rows = client.query(SQL_LIST_TYPES, &[&schema]).await?;
    Ok(rows
        .into_iter()
        .filter_map(|r| {
            let raw = r.get::<_, String>(1);
            let kind = map_type_kind(&raw)?;
            Some(TypeInfo {
                name: r.get::<_, String>(0),
                kind,
                comment: r.get::<_, Option<String>>(2),
            })
        })
        .collect())
}

async fn list_extensions(client: &PgObject, schema: &str) -> AppResult<Vec<ExtensionInfo>> {
    let rows = client.query(SQL_LIST_EXTENSIONS, &[&schema]).await?;
    Ok(rows
        .into_iter()
        .map(|r| ExtensionInfo {
            name: r.get::<_, String>(0),
            version: r.get::<_, String>(1),
            comment: r.get::<_, Option<String>>(2),
        })
        .collect())
}

async fn list_indexes(client: &PgObject, schema: &str) -> AppResult<Vec<IndexInfo>> {
    let rows = client.query(SQL_LIST_INDEXES, &[&schema]).await?;
    Ok(rows
        .into_iter()
        .map(|r| IndexInfo {
            name: r.get::<_, String>(0),
            table: r.get::<_, String>(1),
            is_unique: r.get::<_, bool>(2),
            is_primary: r.get::<_, bool>(3),
            method: r.get::<_, String>(4),
        })
        .collect())
}

async fn list_triggers(client: &PgObject, schema: &str) -> AppResult<Vec<TriggerInfo>> {
    let rows = client.query(SQL_LIST_TRIGGERS, &[&schema]).await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let tgtype: i32 = r.get::<_, i32>(2);
            TriggerInfo {
                name: r.get::<_, String>(0),
                table: r.get::<_, String>(1),
                timing: decode_trigger_timing(tgtype),
                events: decode_trigger_events(tgtype),
                function: r.get::<_, String>(3),
            }
        })
        .collect())
}

pub async fn list_objects(client: &PgObject, schema: &str) -> AppResult<SchemaObjects> {
    tracing::debug!("schema::list_objects start: schema={schema}");

    let mut out = SchemaObjects {
        schema: schema.to_string(),
        tables: Vec::new(),
        views: Vec::new(),
        materialized_views: Vec::new(),
        functions: Vec::new(),
        types: Vec::new(),
        extensions: Vec::new(),
        indexes: Vec::new(),
        triggers: Vec::new(),
    };

    // Six concurrent queries on the same borrowed client. tokio_postgres
    // pipelines them over the single TCP connection, so the round-trip cost
    // is paid once (max(query) instead of sum(query)). Permission-denied for
    // any *structure* kind degrades to an empty Vec via try_kind so a user
    // missing privilege on, say, pg_extension still sees the rest.
    //
    // The data query is NOT wrapped in try_kind: missing privilege there
    // means the user can't see pg_class, which makes browsing the schema
    // meaningless — surface the error.
    let ((), functions, types, extensions, indexes, triggers) = tokio::try_join!(
        fetch_data(client, schema, &mut out),
        try_kind("functions", schema, || list_functions(client, schema)),
        try_kind("types", schema, || list_types(client, schema)),
        try_kind("extensions", schema, || list_extensions(client, schema)),
        try_kind("indexes", schema, || list_indexes(client, schema)),
        try_kind("triggers", schema, || list_triggers(client, schema)),
    )?;

    out.functions = functions;
    out.types = types;
    out.extensions = extensions;
    out.indexes = indexes;
    out.triggers = triggers;

    tracing::debug!(
        "schema::list_objects done: schema={schema} tables={} views={} matviews={} \
         functions={} types={} extensions={} indexes={} triggers={}",
        out.tables.len(),
        out.views.len(),
        out.materialized_views.len(),
        out.functions.len(),
        out.types.len(),
        out.extensions.len(),
        out.indexes.len(),
        out.triggers.len(),
    );

    Ok(out)
}

/// Borrow a client from the registry's pool for the given connection id and
/// invoke the schema-specific query. Returns NotFound if no pool is registered.
pub async fn with_client<F, Fut, T>(
    registry: &PgPoolRegistry,
    id: &uuid::Uuid,
    f: F,
) -> AppResult<T>
where
    F: FnOnce(PgObject) -> Fut,
    Fut: std::future::Future<Output = AppResult<T>>,
{
    let client = registry.acquire(id).await?;
    f(client).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trigger_timing_decodes() {
        assert_eq!(
            decode_trigger_timing(TRIGGER_TYPE_INSTEAD | TRIGGER_TYPE_INSERT),
            TriggerTiming::InsteadOf
        );
        assert_eq!(
            decode_trigger_timing(TRIGGER_TYPE_BEFORE | TRIGGER_TYPE_INSERT),
            TriggerTiming::Before
        );
        assert_eq!(decode_trigger_timing(TRIGGER_TYPE_INSERT), TriggerTiming::After);
    }

    #[test]
    fn trigger_events_decodes() {
        let events = decode_trigger_events(
            TRIGGER_TYPE_INSERT | TRIGGER_TYPE_UPDATE | TRIGGER_TYPE_TRUNCATE,
        );
        assert_eq!(
            events,
            vec![TriggerEvent::Insert, TriggerEvent::Update, TriggerEvent::Truncate]
        );
    }

    #[test]
    fn table_kind_maps() {
        assert_eq!(map_table_kind("r"), TableKind::Regular);
        assert_eq!(map_table_kind("p"), TableKind::Partitioned);
        assert_eq!(map_table_kind("f"), TableKind::Foreign);
    }

    #[test]
    fn type_kind_maps() {
        assert_eq!(map_type_kind("c"), Some(TypeKind::Composite));
        assert_eq!(map_type_kind("e"), Some(TypeKind::Enum));
        assert_eq!(map_type_kind("d"), Some(TypeKind::Domain));
        assert_eq!(map_type_kind("r"), Some(TypeKind::Range));
        assert_eq!(map_type_kind("?"), None);
    }

    #[test]
    fn permission_denied_detected() {
        let err = AppError::postgres_with_code("42501", "permission denied for relation x");
        assert!(is_permission_denied(&err));
        let other = AppError::postgres_with_code("23505", "duplicate key");
        assert!(!is_permission_denied(&other));
        let val = AppError::Validation("nope".into());
        assert!(!is_permission_denied(&val));
    }
}
