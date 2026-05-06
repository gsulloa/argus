use deadpool_postgres::Object as PgObject;
use tokio_postgres::error::SqlState;

use crate::error::{AppError, AppResult};
use crate::modules::postgres::pool::PgPoolRegistry;
use crate::modules::postgres::schema_types::{
    CheckConstraintInfo, ColumnDetail, ExtensionInfo, FkAction, ForeignKeyInfo, ForeignKeyRef,
    FunctionInfo, FunctionSignature, IndexInfo, PrimaryKeyInfo, Relkind, SchemaSummary, TableInfo,
    TableKind, TriggerEvent, TriggerInfo, TriggerTiming, TypeInfo, TypeKind, UniqueConstraintInfo,
    ViewInfo,
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
/// view (v), materialized view (m). Used by `postgres_list_relations` —
/// the cheap query that loads eagerly when a schema becomes visible.
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

/// List functions in a schema **without** their argument signatures. The
/// signature (and return type) is resolved on demand by
/// `postgres_get_function_signature` because `pg_get_function_arguments` is
/// expensive when called per-row over hundreds of overloaded functions.
const SQL_LIST_FUNCTIONS: &str = "\
SELECT p.proname,
       p.oid::int8,
       l.lanname,
       d.description
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
JOIN pg_catalog.pg_language l ON l.oid = p.prolang
LEFT JOIN pg_catalog.pg_description d
       ON d.objoid = p.oid AND d.objsubid = 0 AND d.classoid = 'pg_proc'::regclass
WHERE n.nspname = $1
  AND p.prokind = 'f'
ORDER BY p.proname, p.oid";

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

/// List indexes for a single relation. The `WHERE` clause filters by
/// `n.nspname = $1` and `t.relname = $2` so each call hits only the relevant
/// rows in `pg_index` — orders of magnitude faster than the per-schema
/// variant on schemas with many partitioned tables.
const SQL_LIST_TABLE_INDEXES: &str = "\
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
  AND t.relname = $2
ORDER BY i.relname";

/// Like `SQL_LIST_TABLE_INDEXES` but also pulls the full DDL for each index
/// via `pg_get_indexdef`. The structure command needs both: the lightweight
/// `IndexInfo` for the Structure subtab and the full DDL string for the Raw
/// subtab's reconstructed CREATE TABLE block.
const SQL_LIST_TABLE_INDEXES_WITH_DEF: &str = "\
SELECT i.relname,
       t.relname,
       ix.indisunique,
       ix.indisprimary,
       am.amname,
       pg_catalog.pg_get_indexdef(i.oid, 0, true) AS definition
FROM pg_catalog.pg_index ix
JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
JOIN pg_catalog.pg_namespace n ON n.oid = i.relnamespace
JOIN pg_catalog.pg_am am ON am.oid = i.relam
WHERE n.nspname = $1
  AND t.relname = $2
ORDER BY i.relname";

/// List triggers for a single relation. Same per-table scoping as
/// `SQL_LIST_TABLE_INDEXES`.
const SQL_LIST_TABLE_TRIGGERS: &str = "\
SELECT t.tgname,
       c.relname,
       t.tgtype,
       p.proname || '(' || pg_catalog.pg_get_function_arguments(p.oid) || ')'
FROM pg_catalog.pg_trigger t
JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
WHERE n.nspname = $1
  AND c.relname = $2
  AND NOT t.tgisinternal
ORDER BY t.tgname";

/// Per-relation column metadata for the Structure subtab. Joins against
/// `pg_attrdef` for default expressions, `pg_description` for column comments,
/// and exposes `attidentity` / `attgenerated` so the DDL emitter can mark
/// identity / generated columns. `attidentity` and `attgenerated` are
/// `"char"` columns; we cast to text for portable decoding in Rust.
const SQL_LIST_TABLE_COLUMNS_DETAILED: &str = "\
SELECT a.attname,
       pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
       NOT a.attnotnull AS is_nullable,
       pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_value,
       a.attnum::int4 AS ordinal_position,
       pg_catalog.col_description(c.oid, a.attnum) AS comment,
       NULLIF(a.attidentity::text, '') AS identity_marker,
       NULLIF(a.attgenerated::text, '') AS generated_marker
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_attrdef d
    ON d.adrelid = c.oid AND d.adnum = a.attnum
WHERE n.nspname = $1
  AND c.relname = $2
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY a.attnum";

/// Single PRIMARY KEY constraint per relation (Postgres allows at most one).
/// `conkey` is an `int2[]` of attnums; the lateral lookup turns it into a
/// `text[]` of column names in declaration order.
const SQL_GET_PRIMARY_KEY: &str = "\
SELECT con.conname,
       (SELECT array_agg(a.attname ORDER BY i.ord)
          FROM unnest(con.conkey) WITH ORDINALITY AS i(attnum, ord)
          JOIN pg_catalog.pg_attribute a
            ON a.attrelid = con.conrelid AND a.attnum = i.attnum) AS columns
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1
  AND c.relname = $2
  AND con.contype = 'p'
LIMIT 1";

const SQL_LIST_UNIQUE_CONSTRAINTS: &str = "\
SELECT con.conname,
       (SELECT array_agg(a.attname ORDER BY i.ord)
          FROM unnest(con.conkey) WITH ORDINALITY AS i(attnum, ord)
          JOIN pg_catalog.pg_attribute a
            ON a.attrelid = con.conrelid AND a.attnum = i.attnum) AS columns
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1
  AND c.relname = $2
  AND con.contype = 'u'
ORDER BY con.conname";

const SQL_LIST_CHECK_CONSTRAINTS: &str = "\
SELECT con.conname,
       pg_catalog.pg_get_constraintdef(con.oid, true) AS definition
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1
  AND c.relname = $2
  AND con.contype = 'c'
ORDER BY con.conname";

/// Foreign keys pointing OUT of this relation. Resolves the local column
/// names from `conkey`, the remote schema/relation from `confrelid`, and
/// the remote column names from `confkey`.
const SQL_LIST_FOREIGN_KEYS: &str = "\
SELECT con.conname,
       (SELECT array_agg(a.attname ORDER BY i.ord)
          FROM unnest(con.conkey) WITH ORDINALITY AS i(attnum, ord)
          JOIN pg_catalog.pg_attribute a
            ON a.attrelid = con.conrelid AND a.attnum = i.attnum) AS columns,
       rn.nspname AS ref_schema,
       rc.relname AS ref_relation,
       (SELECT array_agg(a.attname ORDER BY i.ord)
          FROM unnest(con.confkey) WITH ORDINALITY AS i(attnum, ord)
          JOIN pg_catalog.pg_attribute a
            ON a.attrelid = con.confrelid AND a.attnum = i.attnum) AS ref_columns,
       con.confupdtype::text AS on_update,
       con.confdeltype::text AS on_delete,
       con.condeferrable,
       con.condeferred
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_class rc ON rc.oid = con.confrelid
JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
WHERE n.nspname = $1
  AND c.relname = $2
  AND con.contype = 'f'
ORDER BY con.conname";

/// Resolve `(relkind, relispopulated)` for a relation. Returns zero rows if
/// the relation does not exist; the caller maps that to SQLSTATE `42P01`.
const SQL_GET_RELKIND: &str = "\
SELECT c.relkind::text,
       COALESCE(c.relispopulated, true) AS is_populated
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1
  AND c.relname = $2";

/// Pretty-printed view body. Works for both `relkind = 'v'` (regular view)
/// and `relkind = 'm'` (materialized view) — both share the rewrite-rule
/// machinery `pg_get_viewdef` reads.
const SQL_GET_VIEW_DEFINITION: &str = "\
SELECT pg_catalog.pg_get_viewdef(c.oid, true)
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1
  AND c.relname = $2";

/// Resolve a single function's signature by OID. Defense in depth: the WHERE
/// clause also filters by `proname` and `nspname` so a stale OID from the UI
/// can't accidentally surface a different function's signature.
const SQL_GET_FUNCTION_SIGNATURE: &str = "\
SELECT pg_catalog.pg_get_function_arguments(p.oid),
       pg_catalog.pg_get_function_result(p.oid)
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE p.oid = $1::oid
  AND p.proname = $2
  AND n.nspname = $3";

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
pub(crate) fn is_permission_denied(err: &AppError) -> bool {
    if let AppError::Postgres(body) = err {
        if let Some(code) = &body.code {
            return code == SqlState::INSUFFICIENT_PRIVILEGE.code();
        }
    }
    false
}

/// Wrap a kind-specific query: on permission-denied, return an empty Vec and warn.
/// Surfaced from `schema_commands.rs` via the partial-degradation aggregator —
/// the empty Vec is treated as success (`Some(vec![])`), it never enters the
/// `failures` envelope.
pub(crate) async fn try_kind<T, F, Fut>(kind: &'static str, schema: &str, f: F) -> AppResult<Vec<T>>
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

/// Run the unified data query and split rows into (tables, views, materialized_views).
/// Permission-denied at this layer surfaces as an error: a user that cannot see
/// `pg_class` cannot browse the schema at all.
pub async fn list_relations(
    client: &PgObject,
    schema: &str,
) -> AppResult<(Vec<TableInfo>, Vec<ViewInfo>, Vec<ViewInfo>)> {
    let rows = client.query(SQL_LIST_DATA, &[&schema]).await?;
    let mut tables = Vec::new();
    let mut views = Vec::new();
    let mut materialized_views = Vec::new();
    for r in rows {
        let relkind: String = r.get(0);
        let name: String = r.get(1);
        let owner: Option<String> = r.get(2);
        let estimated_rows: Option<i64> = r.get(3);
        let comment: Option<String> = r.get(4);
        match relkind.as_str() {
            "r" | "p" | "f" => {
                tables.push(TableInfo {
                    name,
                    owner,
                    estimated_rows,
                    comment,
                    kind: map_table_kind(&relkind),
                });
            }
            "v" => {
                views.push(ViewInfo {
                    name,
                    owner,
                    comment,
                });
            }
            "m" => {
                materialized_views.push(ViewInfo {
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
    Ok((tables, views, materialized_views))
}

pub async fn list_functions(client: &PgObject, schema: &str) -> AppResult<Vec<FunctionInfo>> {
    let rows = client.query(SQL_LIST_FUNCTIONS, &[&schema]).await?;
    Ok(rows
        .into_iter()
        .map(|r| FunctionInfo {
            name: r.get::<_, String>(0),
            oid: r.get::<_, i64>(1),
            language: r.get::<_, String>(2),
            comment: r.get::<_, Option<String>>(3),
        })
        .collect())
}

pub async fn list_types(client: &PgObject, schema: &str) -> AppResult<Vec<TypeInfo>> {
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

pub async fn list_extensions(client: &PgObject, schema: &str) -> AppResult<Vec<ExtensionInfo>> {
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

pub async fn list_table_indexes(
    client: &PgObject,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<IndexInfo>> {
    let rows = client
        .query(SQL_LIST_TABLE_INDEXES, &[&schema, &relation])
        .await?;
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

/// Variant of `list_table_indexes` that also returns the `pg_get_indexdef`
/// DDL string for each index. Used by the Structure subtab to populate the
/// Raw subtab's `CREATE INDEX` lines without a second round-trip.
pub async fn list_table_indexes_with_def(
    client: &PgObject,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<(IndexInfo, String)>> {
    let rows = client
        .query(SQL_LIST_TABLE_INDEXES_WITH_DEF, &[&schema, &relation])
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let info = IndexInfo {
                name: r.get::<_, String>(0),
                table: r.get::<_, String>(1),
                is_unique: r.get::<_, bool>(2),
                is_primary: r.get::<_, bool>(3),
                method: r.get::<_, String>(4),
            };
            let def: String = r.get(5);
            (info, def)
        })
        .collect())
}

pub async fn list_table_triggers(
    client: &PgObject,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<TriggerInfo>> {
    let rows = client
        .query(SQL_LIST_TABLE_TRIGGERS, &[&schema, &relation])
        .await?;
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

/// Resolve a single function's signature by OID. Returns `AppError::NotFound`
/// when the OID does not match the schema/name pair (UI staleness guard).
/// Decode `confupdtype` / `confdeltype` chars into the typed enum.
fn decode_fk_action(s: &str) -> FkAction {
    match s {
        "r" => FkAction::Restrict,
        "c" => FkAction::Cascade,
        "n" => FkAction::SetNull,
        "d" => FkAction::SetDefault,
        // 'a' or anything unknown falls through to NO ACTION (the catalog
        // default and Postgres' default per the SQL standard).
        _ => FkAction::NoAction,
    }
}

/// Strip a leading `CHECK ` prefix from `pg_get_constraintdef` output. The
/// catalog returns `CHECK ((expr))`; the spec wants just `(expr)` in the
/// `expression` field so the UI can render it without redundant prose.
fn strip_check_prefix(def: &str) -> String {
    let trimmed = def.trim_start();
    if let Some(rest) = trimmed.strip_prefix("CHECK") {
        rest.trim_start().to_string()
    } else {
        def.to_string()
    }
}

pub async fn list_table_columns_detailed(
    client: &PgObject,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<ColumnDetail>> {
    let rows = client
        .query(SQL_LIST_TABLE_COLUMNS_DETAILED, &[&schema, &relation])
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let identity_marker: Option<String> = r.get(6);
            let generated_marker: Option<String> = r.get(7);
            let is_identity = identity_marker
                .as_deref()
                .map(|s| s == "a" || s == "d")
                .unwrap_or(false);
            let is_generated = generated_marker
                .as_deref()
                .map(|s| s == "s")
                .unwrap_or(false);
            ColumnDetail {
                name: r.get::<_, String>(0),
                data_type: r.get::<_, String>(1),
                is_nullable: r.get::<_, bool>(2),
                default: r.get::<_, Option<String>>(3),
                ordinal_position: r.get::<_, i32>(4),
                comment: r.get::<_, Option<String>>(5),
                is_identity,
                is_generated,
            }
        })
        .collect())
}

pub async fn get_primary_key(
    client: &PgObject,
    schema: &str,
    relation: &str,
) -> AppResult<Option<PrimaryKeyInfo>> {
    let rows = client
        .query(SQL_GET_PRIMARY_KEY, &[&schema, &relation])
        .await?;
    Ok(rows.into_iter().next().map(|r| PrimaryKeyInfo {
        name: r.get::<_, String>(0),
        columns: r.get::<_, Vec<String>>(1),
    }))
}

pub async fn list_unique_constraints(
    client: &PgObject,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<UniqueConstraintInfo>> {
    let rows = client
        .query(SQL_LIST_UNIQUE_CONSTRAINTS, &[&schema, &relation])
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| UniqueConstraintInfo {
            name: r.get::<_, String>(0),
            columns: r.get::<_, Vec<String>>(1),
        })
        .collect())
}

pub async fn list_check_constraints(
    client: &PgObject,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<CheckConstraintInfo>> {
    let rows = client
        .query(SQL_LIST_CHECK_CONSTRAINTS, &[&schema, &relation])
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| CheckConstraintInfo {
            name: r.get::<_, String>(0),
            expression: strip_check_prefix(&r.get::<_, String>(1)),
        })
        .collect())
}

pub async fn list_foreign_keys(
    client: &PgObject,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<ForeignKeyInfo>> {
    let rows = client
        .query(SQL_LIST_FOREIGN_KEYS, &[&schema, &relation])
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let on_update: String = r.get(5);
            let on_delete: String = r.get(6);
            ForeignKeyInfo {
                name: r.get::<_, String>(0),
                columns: r.get::<_, Vec<String>>(1),
                references: ForeignKeyRef {
                    schema: r.get::<_, String>(2),
                    relation: r.get::<_, String>(3),
                    columns: r.get::<_, Vec<String>>(4),
                },
                on_update: decode_fk_action(&on_update),
                on_delete: decode_fk_action(&on_delete),
                deferrable: r.get::<_, bool>(7),
                initially_deferred: r.get::<_, bool>(8),
            }
        })
        .collect())
}

/// Look up `(relkind, is_populated)` for a relation, returning `42P01` when
/// the relation is missing. The data viewer only opens tabs for `r/p/v/m`,
/// so any other relkind is reported as `Table` with `is_best_effort = true`
/// upstream — but we still allow the catalog to return what it returns so
/// the response is honest.
pub async fn get_relkind(
    client: &PgObject,
    schema: &str,
    relation: &str,
) -> AppResult<(Relkind, bool, bool)> {
    let rows = client.query(SQL_GET_RELKIND, &[&schema, &relation]).await?;
    let row = rows.into_iter().next().ok_or_else(|| {
        AppError::postgres_with_code(
            "42P01",
            format!("relation \"{schema}\".\"{relation}\" does not exist"),
        )
    })?;
    let relkind_raw: String = row.get(0);
    let is_populated: bool = row.get(1);
    let (kind, best_effort) = match relkind_raw.as_str() {
        "r" => (Relkind::Table, false),
        "p" => (Relkind::Table, true),  // partitioned: best-effort DDL
        "f" => (Relkind::Table, true),  // foreign: best-effort DDL
        "v" => (Relkind::View, false),
        "m" => (Relkind::MaterializedView, false),
        other => {
            tracing::warn!(
                "table_structure: unexpected relkind '{other}' for {schema}.{relation}"
            );
            (Relkind::Table, true)
        }
    };
    Ok((kind, is_populated, best_effort))
}

/// Fetch the pretty-printed view body for a regular view or materialized view.
/// Returns `42P01` if the relation no longer exists.
pub async fn get_view_definition(
    client: &PgObject,
    schema: &str,
    relation: &str,
) -> AppResult<String> {
    let rows = client
        .query(SQL_GET_VIEW_DEFINITION, &[&schema, &relation])
        .await?;
    let row = rows.into_iter().next().ok_or_else(|| {
        AppError::postgres_with_code(
            "42P01",
            format!("relation \"{schema}\".\"{relation}\" does not exist"),
        )
    })?;
    Ok(row.get::<_, String>(0))
}

pub async fn get_function_signature(
    client: &PgObject,
    schema: &str,
    name: &str,
    oid: i64,
) -> AppResult<FunctionSignature> {
    let rows = client
        .query(SQL_GET_FUNCTION_SIGNATURE, &[&oid, &name, &schema])
        .await?;
    let row = rows.first().ok_or_else(|| {
        AppError::NotFound(format!(
            "function oid={oid} schema={schema} name={name} not found"
        ))
    })?;
    Ok(FunctionSignature {
        args_signature: row.get::<_, String>(0),
        return_type: row.get::<_, Option<String>>(1),
    })
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
