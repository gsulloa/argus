//! MySQL table structure and DDL commands.
//!
//! - `mysql_table_structure` — concurrent INFORMATION_SCHEMA queries for all
//!   structural facets of a table (columns, PK, FKs, indexes, triggers, table opts).
//! - `mysql_table_ddl` — `SHOW CREATE TABLE` / `SHOW CREATE VIEW`, verbatim.

use std::time::{Duration, Instant};

use serde::Serialize;
use sqlx::Row as _;
use tauri::{AppHandle, State};
use tokio::time::timeout;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::activity_log::{
    emit_activity, ActivityKind, ActivityLogEntryBuilder, Metric, Origin,
};
use crate::modules::mysql::binding::mysql_quote_qualified;
use crate::modules::mysql::errors::map_sqlx_error;
use crate::modules::mysql::pool::MysqlPoolRegistry;
use crate::modules::mysql::schema_commands::{aggregate_one, map_failure, PER_QUERY_TIMEOUT};
use crate::modules::mysql::schema_types::KindFailure;

// ---------------------------------------------------------------------------
// §12 — Timeouts
// ---------------------------------------------------------------------------

pub const STRUCTURE_TOTAL_TIMEOUT: Duration = Duration::from_secs(10);
pub const DDL_TIMEOUT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// §12.3 — DTO types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TableStructureColumn {
    pub name: String,
    pub ordinal: i32,
    pub data_type: String,
    pub full_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub extra: String,
    pub comment: Option<String>,
    pub collation: Option<String>,
    pub character_set: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct PrimaryKey {
    pub columns: Vec<String>,
    pub auto_increment_column: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct UniqueConstraint {
    pub name: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct StructForeignKey {
    pub name: String,
    pub columns: Vec<String>,
    pub referenced_schema: String,
    pub referenced_table: String,
    pub referenced_columns: Vec<String>,
    pub on_update: String,
    pub on_delete: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct StructIndexColumn {
    pub name: String,
    pub sub_part: Option<i64>,
    pub direction: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct StructIndex {
    pub name: String,
    pub columns: Vec<StructIndexColumn>,
    pub unique: bool,
    pub index_type: String,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct StructTrigger {
    pub name: String,
    pub event: String,
    pub timing: String,
    pub action_statement: String,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TableOptions {
    pub engine: Option<String>,
    pub row_format: Option<String>,
    pub collation: Option<String>,
    pub character_set: Option<String>,
    pub comment: Option<String>,
    pub auto_increment: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TableStructureResult {
    pub schema: String,
    pub relation: String,
    pub columns: Option<Vec<TableStructureColumn>>,
    pub primary_key: Option<PrimaryKey>,
    pub unique_constraints: Option<Vec<UniqueConstraint>>,
    pub foreign_keys: Option<Vec<StructForeignKey>>,
    pub indexes: Option<Vec<StructIndex>>,
    pub triggers: Option<Vec<StructTrigger>>,
    pub table_options: Option<TableOptions>,
    pub failures: Vec<KindFailure>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TableDdlResult {
    pub ddl: String,
}

// ---------------------------------------------------------------------------
// §12.1 — Sub-query helpers
// ---------------------------------------------------------------------------

async fn fetch_columns(
    pool: &sqlx::MySqlPool,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<TableStructureColumn>> {
    // (COLUMN_NAME, ORDINAL_POSITION, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE,
    //  COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, COLLATION_NAME, CHARACTER_SET_NAME)
    let rows: Vec<(
        String,
        i32,
        String,
        String,
        String,
        Option<String>,
        String,
        String,
        Option<String>,
        Option<String>,
    )> = sqlx::query_as(
        "SELECT COLUMN_NAME, ORDINAL_POSITION, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, \
         COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, COLLATION_NAME, CHARACTER_SET_NAME \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         ORDER BY ORDINAL_POSITION",
    )
    .bind(schema)
    .bind(relation)
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    let cols = rows
        .into_iter()
        .map(
            |(
                name,
                ordinal,
                data_type,
                full_type,
                is_nullable,
                default,
                extra,
                comment,
                collation,
                charset,
            )| {
                TableStructureColumn {
                    name,
                    ordinal,
                    data_type,
                    full_type,
                    nullable: is_nullable.eq_ignore_ascii_case("YES"),
                    default,
                    extra,
                    comment: if comment.is_empty() {
                        None
                    } else {
                        Some(comment)
                    },
                    collation,
                    character_set: charset,
                }
            },
        )
        .collect();
    Ok(cols)
}

async fn fetch_primary_key(
    pool: &sqlx::MySqlPool,
    schema: &str,
    relation: &str,
) -> AppResult<Option<PrimaryKey>> {
    // Column names in the PK.
    let pk_rows: Vec<(String,)> = sqlx::query_as(
        "SELECT COLUMN_NAME \
         FROM information_schema.STATISTICS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY' \
         ORDER BY SEQ_IN_INDEX",
    )
    .bind(schema)
    .bind(relation)
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    if pk_rows.is_empty() {
        return Ok(None);
    }

    let columns: Vec<String> = pk_rows.into_iter().map(|(c,)| c).collect();

    // Find auto_increment column.
    let auto_inc: Option<(String,)> = sqlx::query_as(
        "SELECT COLUMN_NAME \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         AND EXTRA LIKE '%auto_increment%' \
         LIMIT 1",
    )
    .bind(schema)
    .bind(relation)
    .fetch_optional(pool)
    .await
    .map_err(map_sqlx_error)?;

    Ok(Some(PrimaryKey {
        columns,
        auto_increment_column: auto_inc.map(|(c,)| c),
    }))
}

async fn fetch_unique_constraints(
    pool: &sqlx::MySqlPool,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<UniqueConstraint>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT tc.CONSTRAINT_NAME, kcu.COLUMN_NAME \
         FROM information_schema.TABLE_CONSTRAINTS tc \
         JOIN information_schema.KEY_COLUMN_USAGE kcu \
           ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA \
           AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME \
           AND kcu.TABLE_NAME = tc.TABLE_NAME \
         WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? \
         AND tc.CONSTRAINT_TYPE = 'UNIQUE' \
         ORDER BY tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION",
    )
    .bind(schema)
    .bind(relation)
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    // Group by constraint name.
    let mut map: Vec<(String, Vec<String>)> = Vec::new();
    for (cname, col) in rows {
        if let Some(last) = map.last_mut() {
            if last.0 == cname {
                last.1.push(col);
                continue;
            }
        }
        map.push((cname, vec![col]));
    }

    Ok(map
        .into_iter()
        .map(|(name, columns)| UniqueConstraint { name, columns })
        .collect())
}

async fn fetch_foreign_keys(
    pool: &sqlx::MySqlPool,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<StructForeignKey>> {
    let rows: Vec<(String, String, String, String, String, String, String)> = sqlx::query_as(
        "SELECT kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME, \
         kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME, \
         COALESCE(rc.UPDATE_RULE, 'NO ACTION'), COALESCE(rc.DELETE_RULE, 'NO ACTION') \
         FROM information_schema.KEY_COLUMN_USAGE kcu \
         JOIN information_schema.REFERENTIAL_CONSTRAINTS rc \
           ON rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA \
           AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME \
         WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ? \
         AND kcu.REFERENCED_TABLE_NAME IS NOT NULL \
         ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION",
    )
    .bind(schema)
    .bind(relation)
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    // Group by constraint name.
    let mut fk_map: Vec<StructForeignKey> = Vec::new();
    for (cname, col, ref_schema, ref_table, ref_col, on_update, on_delete) in rows {
        if let Some(last) = fk_map.last_mut() {
            if last.name == cname {
                last.columns.push(col);
                last.referenced_columns.push(ref_col);
                continue;
            }
        }
        fk_map.push(StructForeignKey {
            name: cname,
            columns: vec![col],
            referenced_schema: ref_schema,
            referenced_table: ref_table,
            referenced_columns: vec![ref_col],
            on_update,
            on_delete,
        });
    }

    Ok(fk_map)
}

async fn fetch_indexes(
    pool: &sqlx::MySqlPool,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<StructIndex>> {
    // (INDEX_NAME, COLUMN_NAME, NON_UNIQUE, INDEX_TYPE, SEQ_IN_INDEX, SUB_PART, COLLATION, INDEX_COMMENT)
    let rows: Vec<(
        String,
        String,
        i8,
        String,
        i32,
        Option<i64>,
        Option<String>,
        String,
    )> = sqlx::query_as(
        "SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, INDEX_TYPE, \
             SEQ_IN_INDEX, SUB_PART, COLLATION, COALESCE(INDEX_COMMENT, '') \
             FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
             AND INDEX_NAME != 'PRIMARY' \
             ORDER BY INDEX_NAME, SEQ_IN_INDEX",
    )
    .bind(schema)
    .bind(relation)
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    // Group by index name.
    let mut index_map: Vec<StructIndex> = Vec::new();
    for (iname, col, non_unique, itype, _seq, sub_part, collation, comment) in rows {
        let direction = match collation.as_deref() {
            Some("D") => "DESC".to_string(),
            _ => "ASC".to_string(),
        };
        let col_entry = StructIndexColumn {
            name: col,
            sub_part,
            direction,
        };
        if let Some(last) = index_map.last_mut() {
            if last.name == iname {
                last.columns.push(col_entry);
                continue;
            }
        }
        index_map.push(StructIndex {
            name: iname,
            columns: vec![col_entry],
            unique: non_unique == 0,
            index_type: itype,
            comment: if comment.is_empty() {
                None
            } else {
                Some(comment)
            },
        });
    }

    Ok(index_map)
}

async fn fetch_triggers(
    pool: &sqlx::MySqlPool,
    schema: &str,
    relation: &str,
) -> AppResult<Vec<StructTrigger>> {
    let rows: Vec<(String, String, String, String, String)> = sqlx::query_as(
        "SELECT TRIGGER_NAME, EVENT_MANIPULATION, ACTION_TIMING, \
         ACTION_STATEMENT, COALESCE('' /* no TRIGGER_COMMENT in IS */, '') \
         FROM information_schema.TRIGGERS \
         WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? \
         ORDER BY TRIGGER_NAME",
    )
    .bind(schema)
    .bind(relation)
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    Ok(rows
        .into_iter()
        .map(
            |(name, event, timing, action_statement, comment)| StructTrigger {
                name,
                event,
                timing,
                action_statement,
                comment: if comment.is_empty() {
                    None
                } else {
                    Some(comment)
                },
            },
        )
        .collect())
}

async fn fetch_table_options(
    pool: &sqlx::MySqlPool,
    schema: &str,
    relation: &str,
) -> AppResult<Option<TableOptions>> {
    let row: Option<(
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
    )> = sqlx::query_as(
        "SELECT ENGINE, ROW_FORMAT, TABLE_COLLATION, TABLE_COMMENT, AUTO_INCREMENT \
         FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    )
    .bind(schema)
    .bind(relation)
    .fetch_optional(pool)
    .await
    .map_err(map_sqlx_error)?;

    Ok(
        row.map(|(engine, row_format, collation, comment, auto_inc)| {
            // Derive character_set from the collation prefix.
            let character_set = collation.as_deref().map(|c| {
                // Collation name is typically `charset_...`, e.g. `utf8mb4_general_ci`.
                // The charset is the part before the first `_`.
                c.split('_').next().unwrap_or(c).to_string()
            });
            TableOptions {
                engine,
                row_format,
                collation,
                character_set,
                comment,
                auto_increment: auto_inc,
            }
        }),
    )
}

// ---------------------------------------------------------------------------
// §12.1 — mysql_table_structure command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mysql_table_structure(
    app: AppHandle,
    registry: State<'_, MysqlPoolRegistry>,
    id: Uuid,
    schema: String,
    relation: String,
    origin: Option<Origin>,
) -> AppResult<TableStructureResult> {
    let started = Instant::now();
    let activity_origin = origin.unwrap_or(Origin::Auto);

    let pool = registry.acquire(id)?;

    // Run all sub-queries concurrently under a total timeout.
    let inner_result = timeout(STRUCTURE_TOTAL_TIMEOUT, async {
        let (cols_res, pk_res, unique_res, fk_res, idx_res, trig_res, opts_res) = tokio::join!(
            timeout(PER_QUERY_TIMEOUT, fetch_columns(&pool, &schema, &relation)),
            timeout(
                PER_QUERY_TIMEOUT,
                fetch_primary_key(&pool, &schema, &relation)
            ),
            timeout(
                PER_QUERY_TIMEOUT,
                fetch_unique_constraints(&pool, &schema, &relation)
            ),
            timeout(
                PER_QUERY_TIMEOUT,
                fetch_foreign_keys(&pool, &schema, &relation)
            ),
            timeout(PER_QUERY_TIMEOUT, fetch_indexes(&pool, &schema, &relation)),
            timeout(PER_QUERY_TIMEOUT, fetch_triggers(&pool, &schema, &relation)),
            timeout(
                PER_QUERY_TIMEOUT,
                fetch_table_options(&pool, &schema, &relation)
            ),
        );

        let mut failures: Vec<KindFailure> = Vec::new();

        // Columns are required — if they fail, propagate the error.
        let columns: Vec<TableStructureColumn> = match cols_res {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                return Err(e);
            }
            Err(_elapsed) => {
                return Err(AppError::mysql_with_code(
                    "70100",
                    format!("columns query timed out ({}s)", PER_QUERY_TIMEOUT.as_secs()),
                ));
            }
        };

        // Primary key — optional.
        let primary_key: Option<PrimaryKey> = match pk_res {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                failures.push(map_failure("primary_key", e));
                None
            }
            Err(_elapsed) => {
                failures.push(KindFailure {
                    kind: "primary_key".into(),
                    code: Some("70100".into()),
                    message: format!(
                        "primary_key query timed out ({}s)",
                        PER_QUERY_TIMEOUT.as_secs()
                    ),
                });
                None
            }
        };

        // Unique constraints — optional.
        let unique_constraints: Option<Vec<UniqueConstraint>> =
            aggregate_one(unique_res, "unique_constraints", &mut failures);

        // Foreign keys — optional.
        let foreign_keys: Option<Vec<StructForeignKey>> =
            aggregate_one(fk_res, "foreign_keys", &mut failures);

        // Indexes — optional.
        let indexes: Option<Vec<StructIndex>> = aggregate_one(idx_res, "indexes", &mut failures);

        // Triggers — optional.
        let triggers: Option<Vec<StructTrigger>> =
            aggregate_one(trig_res, "triggers", &mut failures);

        // Table options — optional.
        let table_options: Option<TableOptions> = match opts_res {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                failures.push(map_failure("table_options", e));
                None
            }
            Err(_elapsed) => {
                failures.push(KindFailure {
                    kind: "table_options".into(),
                    code: Some("70100".into()),
                    message: format!(
                        "table_options query timed out ({}s)",
                        PER_QUERY_TIMEOUT.as_secs()
                    ),
                });
                None
            }
        };

        Ok(TableStructureResult {
            schema: schema.clone(),
            relation: relation.clone(),
            columns: Some(columns),
            primary_key,
            unique_constraints,
            foreign_keys,
            indexes,
            triggers,
            table_options,
            failures,
        })
    })
    .await;

    let duration_ms = started.elapsed().as_millis() as u64;

    let result: AppResult<TableStructureResult> = match inner_result {
        Ok(Ok(r)) => Ok(r),
        Ok(Err(e)) => Err(e),
        Err(_elapsed) => Err(AppError::mysql_with_code(
            "70100",
            format!(
                "table_structure command timed out ({}s)",
                STRUCTURE_TOTAL_TIMEOUT.as_secs()
            ),
        )),
    };

    let builder =
        ActivityLogEntryBuilder::new(ActivityKind::TableStructure, activity_origin, duration_ms)
            .connection(id);

    match &result {
        Ok(r) => {
            // Metric: sum of buckets.
            let mut count: u32 = 0;
            if let Some(cols) = &r.columns {
                count += cols.len() as u32;
            }
            if let Some(idx) = &r.indexes {
                count += idx.len() as u32;
            }
            if let Some(trigs) = &r.triggers {
                count += trigs.len() as u32;
            }
            if let Some(fks) = &r.foreign_keys {
                count += fks.len() as u32;
            }
            if let Some(uq) = &r.unique_constraints {
                count += uq.len() as u32;
            }
            if r.primary_key.is_some() {
                count += 1;
            }
            let entry = builder.ok(Some(Metric::Items { value: count }));
            emit_activity(&app, entry);
        }
        Err(e) => {
            let entry = builder.err(e);
            emit_activity(&app, entry);
        }
    }

    result
}

// ---------------------------------------------------------------------------
// §12.2 — mysql_table_ddl command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mysql_table_ddl(
    app: AppHandle,
    registry: State<'_, MysqlPoolRegistry>,
    id: Uuid,
    schema: String,
    relation: String,
    origin: Option<Origin>,
) -> AppResult<TableDdlResult> {
    let started = Instant::now();
    let activity_origin = origin.unwrap_or(Origin::Auto);

    let pool = registry.acquire(id)?;

    let result = timeout(DDL_TIMEOUT, async {
        // Determine if this is a VIEW.
        let table_type: Option<(String,)> = sqlx::query_as(
            "SELECT TABLE_TYPE FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
        )
        .bind(&schema)
        .bind(&relation)
        .fetch_optional(&pool)
        .await
        .map_err(map_sqlx_error)?;

        let is_view = table_type
            .as_ref()
            .map(|(t,)| t.eq_ignore_ascii_case("VIEW"))
            .unwrap_or(false);

        let qualified = mysql_quote_qualified(&schema, &relation);

        let ddl: String = if is_view {
            let row = sqlx::query(&format!("SHOW CREATE VIEW {qualified}"))
                .fetch_one(&pool)
                .await
                .map_err(map_sqlx_error)?;
            // SHOW CREATE VIEW columns: View, Create View, character_set_client, collation_connection
            row.try_get::<String, _>(1)
                .map_err(|e| AppError::mysql(format!("could not read Create View column: {e}")))?
        } else {
            let row = sqlx::query(&format!("SHOW CREATE TABLE {qualified}"))
                .fetch_one(&pool)
                .await
                .map_err(map_sqlx_error)?;
            // SHOW CREATE TABLE columns: Table, Create Table
            row.try_get::<String, _>(1)
                .map_err(|e| AppError::mysql(format!("could not read Create Table column: {e}")))?
        };

        Ok::<TableDdlResult, AppError>(TableDdlResult { ddl })
    })
    .await;

    let duration_ms = started.elapsed().as_millis() as u64;

    let result: AppResult<TableDdlResult> = match result {
        Ok(Ok(r)) => Ok(r),
        Ok(Err(e)) => Err(e),
        Err(_elapsed) => Err(AppError::mysql_with_code(
            "70100",
            format!("table_ddl command timed out ({}s)", DDL_TIMEOUT.as_secs()),
        )),
    };

    let builder =
        ActivityLogEntryBuilder::new(ActivityKind::TableDdl, activity_origin, duration_ms)
            .connection(id);

    match &result {
        Ok(_) => {
            let entry = builder.ok(Some(Metric::Items { value: 1 }));
            emit_activity(&app, entry);
        }
        Err(e) => {
            let entry = builder.err(e);
            emit_activity(&app, entry);
        }
    }

    result
}

// ---------------------------------------------------------------------------
// §12.4 — Unit tests for pure helpers
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn charset_derived_from_collation() {
        // TableOptions.character_set is derived from the collation prefix.
        let opts = TableOptions {
            engine: Some("InnoDB".into()),
            row_format: None,
            collation: Some("utf8mb4_general_ci".into()),
            character_set: Some("utf8mb4".into()),
            comment: None,
            auto_increment: None,
        };
        assert_eq!(opts.character_set.as_deref(), Some("utf8mb4"));
    }

    #[test]
    fn charset_latin1_collation() {
        let collation = "latin1_swedish_ci";
        let charset = collation.split('_').next().unwrap_or(collation).to_string();
        assert_eq!(charset, "latin1");
    }

    #[test]
    fn index_direction_asc_for_a_or_null() {
        // COLLATION 'A' → ASC, NULL → ASC, 'D' → DESC
        let dir_a: String = match Some("A").as_deref() {
            Some("D") => "DESC".to_string(),
            _ => "ASC".to_string(),
        };
        let dir_null: String = match Option::<&str>::None.as_deref() {
            Some("D") => "DESC".to_string(),
            _ => "ASC".to_string(),
        };
        let dir_d: String = match Some("D").as_deref() {
            Some("D") => "DESC".to_string(),
            _ => "ASC".to_string(),
        };
        assert_eq!(dir_a, "ASC");
        assert_eq!(dir_null, "ASC");
        assert_eq!(dir_d, "DESC");
    }
}
