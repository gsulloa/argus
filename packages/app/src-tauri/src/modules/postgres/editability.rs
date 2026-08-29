//! Decides whether an ad-hoc SQL result set can be written back.
//!
//! The question "can the user edit this result?" has an exact answer that does
//! not require parsing the statement. Postgres' `RowDescription` reports, per
//! field, the OID of the relation the value came from and that column's
//! `attnum` — zero for anything that isn't a plain column reference. A join
//! reports two distinct OIDs, `count(*)` reports none, and `SELECT id AS pk`
//! still reports `users.id`, so an aliased projection can be written to its
//! real column name.
//!
//! This module turns that provenance (captured as [`ColumnProvenance`] in
//! `sql.rs`) into a [`ResultEditability`] payload the frontend can act on.
//!
//! Two rules govern everything here:
//!
//! 1. **Never fail the run.** Resolution is best-effort metadata. Any catalog
//!    error, timeout, or unexpected shape degrades to "not editable" and logs a
//!    warning. A user who cannot edit a result is inconvenienced; a user whose
//!    `SELECT` fails because a metadata lookup hiccupped is blocked.
//! 2. **Never guess.** If provenance does not prove a single ordinary table
//!    with its full primary key projected exactly once, the answer is no.

use std::collections::BTreeMap;
use std::time::Duration;

use deadpool_postgres::Object as PgObject;
use serde::Serialize;
use tokio::time::timeout;

use crate::modules::postgres::edit::{lookup_enums, lookup_pk_columns};
use crate::modules::postgres::sql::ColumnProvenance;

/// Cap on the whole resolution. Deliberately short: this is metadata riding
/// alongside a result the user is already waiting for, and the fallback
/// ("not editable") is cheap. Catalog tables are hot; if we are past this
/// budget something is wrong and the user is better served by their rows.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(3);

/// Why a result set cannot be edited. Closed set, snake_case on the wire, with
/// no free-form text — user-facing copy lives in the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EditBlockReason {
    /// Nothing in the projection resolves to a relation column (aggregate-only,
    /// literal-only, `EXPLAIN`, function result) — or resolution failed.
    NoBaseTable,
    /// Columns come from more than one relation (join, UNION, multi-relation CTE).
    MultipleTables,
    /// Single relation, but not an ordinary or partitioned table.
    NotATable,
    /// The relation has no primary key, so rows have no stable identity.
    NoPrimaryKey,
    /// The relation has a primary key, but it isn't fully projected.
    PkNotSelected,
    /// The same base column appears more than once in the projection.
    DuplicateProjection,
}

/// Whether an ad-hoc rows result can be written back, and everything the
/// frontend needs to do so. See `openspec/specs/sql-result-editability`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ResultEditability {
    Editable {
        schema: String,
        relation: String,
        /// PK column names in declared order.
        pk_columns: Vec<String>,
        /// Index into `columns` carrying each PK column, aligned to `pk_columns`.
        pk_column_indexes: Vec<usize>,
        /// Per result column: the base column it projects, or `None` when the
        /// column is computed. Same length as the result's `columns`.
        column_sources: Vec<Option<String>>,
        /// Enum labels keyed by **base** column name.
        enums: BTreeMap<String, Vec<String>>,
    },
    NotEditable {
        reason: EditBlockReason,
    },
}

impl ResultEditability {
    /// The catch-all negative answer. Also the degraded result whenever
    /// resolution cannot complete — see the module docs.
    pub fn not_editable(reason: EditBlockReason) -> Self {
        ResultEditability::NotEditable { reason }
    }
}

/// A relation resolved from a `table_oid`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedRelation {
    pub schema: String,
    pub relation: String,
    /// `pg_class.relkind`. Only `r` (ordinary) and `p` (partitioned) are writable.
    pub relkind: String,
}

impl ResolvedRelation {
    /// Ordinary and partitioned tables only.
    ///
    /// Views are excluded deliberately: an auto-updatable view would mostly
    /// work through the apply command, and "mostly" is the wrong guarantee for
    /// a write path — a view with a non-trivial rule set fails at COMMIT with
    /// an error the user cannot act on. Foreign tables are excluded because
    /// writability depends on the FDW.
    fn is_writable_kind(&self) -> bool {
        self.relkind == "r" || self.relkind == "p"
    }
}

/// The pure decision. Every branch here is unit-tested; the async wrapper below
/// only gathers inputs.
///
/// `sources[i]` is the base column name projected by result column `i`, or
/// `None` when that column is computed.
pub fn decide(
    relation: Option<ResolvedRelation>,
    sources: &[Option<String>],
    pk_columns: Option<&[String]>,
    enums: BTreeMap<String, Vec<String>>,
) -> ResultEditability {
    let Some(rel) = relation else {
        return ResultEditability::not_editable(EditBlockReason::NoBaseTable);
    };
    if !rel.is_writable_kind() {
        return ResultEditability::not_editable(EditBlockReason::NotATable);
    }
    if sources.iter().all(|s| s.is_none()) {
        return ResultEditability::not_editable(EditBlockReason::NoBaseTable);
    }

    // The buffer keys pending edits by base column name, so two result columns
    // projecting the same base column would share one entry: editing one would
    // silently repaint the other with a value the user never typed there.
    // Note this counts only *sourced* columns — two unrelated computed columns
    // are not duplicates.
    let mut seen: Vec<&str> = Vec::with_capacity(sources.len());
    for name in sources.iter().flatten() {
        if seen.contains(&name.as_str()) {
            return ResultEditability::not_editable(EditBlockReason::DuplicateProjection);
        }
        seen.push(name.as_str());
    }

    let pk_columns = match pk_columns {
        Some(pk) if !pk.is_empty() => pk,
        _ => return ResultEditability::not_editable(EditBlockReason::NoPrimaryKey),
    };

    // Every PK column must be projected, else we cannot address a row.
    let mut pk_column_indexes: Vec<usize> = Vec::with_capacity(pk_columns.len());
    for pk in pk_columns {
        let Some(idx) = sources
            .iter()
            .position(|s| s.as_deref() == Some(pk.as_str()))
        else {
            return ResultEditability::not_editable(EditBlockReason::PkNotSelected);
        };
        pk_column_indexes.push(idx);
    }

    ResultEditability::Editable {
        schema: rel.schema,
        relation: rel.relation,
        pk_columns: pk_columns.to_vec(),
        pk_column_indexes,
        column_sources: sources.to_vec(),
        enums,
    }
}

const SQL_RESOLVE_RELATION: &str = "\
SELECT n.nspname, c.relname, c.relkind::text
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.oid = $1";

const SQL_RESOLVE_ATTNAMES: &str = "\
SELECT a.attnum, a.attname
FROM pg_catalog.pg_attribute a
WHERE a.attrelid = $1
  AND a.attnum = ANY ($2)
  AND NOT a.attisdropped";

/// Resolve editability for a prepared statement's result columns.
///
/// Short-circuits without touching the catalog when no column carries relation
/// provenance, so `SELECT 1`, aggregates, `EXPLAIN` and DDL pay nothing.
///
/// Never returns an error: any failure degrades to
/// `not_editable { no_base_table }` and logs at `warn`.
pub async fn resolve(client: &PgObject, provenance: &[ColumnProvenance]) -> ResultEditability {
    // Answer from provenance alone when we can — zero round-trips for
    // `SELECT 1`, aggregates, EXPLAIN, and every join.
    if let Some(answer) = short_circuit(provenance) {
        return answer;
    }
    // `short_circuit` returned None, so there is exactly one distinct oid.
    let Some(oid) = sourced_oids(provenance).first().copied() else {
        return ResultEditability::not_editable(EditBlockReason::NoBaseTable);
    };

    match timeout(RESOLVE_TIMEOUT, resolve_inner(client, provenance, oid)).await {
        Ok(Ok(e)) => e,
        Ok(Err(e)) => {
            tracing::warn!("editability: catalog lookup failed, treating result as read-only: {e}");
            ResultEditability::not_editable(EditBlockReason::NoBaseTable)
        }
        Err(_) => {
            tracing::warn!(
                "editability: catalog lookup exceeded {}s, treating result as read-only",
                RESOLVE_TIMEOUT.as_secs()
            );
            ResultEditability::not_editable(EditBlockReason::NoBaseTable)
        }
    }
}

async fn resolve_inner(
    client: &PgObject,
    provenance: &[ColumnProvenance],
    oid: u32,
) -> Result<ResultEditability, tokio_postgres::Error> {
    // `postgres-types` maps `u32` to `OID` and `i16` to `INT2`, so both binds
    // land on the catalog's native column types. Binding the oid as `i64`
    // instead would fail with `operator does not exist: oid = bigint`.
    let rel_rows = client.query(SQL_RESOLVE_RELATION, &[&oid]).await?;
    let Some(rel_row) = rel_rows.first() else {
        // The relation vanished between prepare and lookup (dropped mid-flight).
        return Ok(ResultEditability::not_editable(
            EditBlockReason::NoBaseTable,
        ));
    };
    let relation = ResolvedRelation {
        schema: rel_row.get::<_, String>(0),
        relation: rel_row.get::<_, String>(1),
        relkind: rel_row.get::<_, String>(2),
    };

    // Bail before the remaining queries when the relkind already disqualifies
    // the relation — a view's PK/enum lookup would be wasted work.
    if !relation.is_writable_kind() {
        return Ok(ResultEditability::not_editable(EditBlockReason::NotATable));
    }

    // Map each projected attnum to its column name. Only fully-sourced columns
    // are looked up — a system column's attnum would match nothing anyway.
    let attnums: Vec<i16> = provenance
        .iter()
        .filter(|p| p.is_sourced())
        .filter_map(|p| p.attnum)
        .collect();
    let attname_rows = client
        .query(SQL_RESOLVE_ATTNAMES, &[&oid, &attnums])
        .await?;
    let mut by_attnum: BTreeMap<i16, String> = BTreeMap::new();
    for row in attname_rows {
        by_attnum.insert(row.get::<_, i16>(0), row.get::<_, String>(1));
    }
    // A dropped column resolves to no name, which correctly makes that result
    // column non-editable rather than mis-targeting a neighbour.
    let sources: Vec<Option<String>> = provenance
        .iter()
        .map(|p| {
            if !p.is_sourced() {
                return None;
            }
            p.attnum.and_then(|a| by_attnum.get(&a)).cloned()
        })
        .collect();

    let pk_columns = lookup_pk_columns(client, &relation.schema, &relation.relation)
        .await
        .unwrap_or(None);
    // Enum metadata only drives dropdowns — a failure degrades to plain inputs.
    let enums = lookup_enums(client, &relation.schema, &relation.relation)
        .await
        .unwrap_or_default();

    Ok(decide(
        Some(relation),
        &sources,
        pk_columns.as_deref(),
        enums,
    ))
}

/// Distinct relation OIDs across the projection, counting only columns that
/// carry full provenance (a real relation column, not a system column).
fn sourced_oids(provenance: &[ColumnProvenance]) -> Vec<u32> {
    let mut oids: Vec<u32> = Vec::new();
    for p in provenance.iter().filter(|p| p.is_sourced()) {
        if let Some(oid) = p.table_oid {
            if !oids.contains(&oid) {
                oids.push(oid);
            }
        }
    }
    oids
}

/// The zero-round-trip half of [`resolve`]: returns `Some(answer)` when the
/// provenance alone settles the question, `None` when the catalog must be
/// consulted. Split out so it is directly testable — see the tests above.
pub(crate) fn short_circuit(provenance: &[ColumnProvenance]) -> Option<ResultEditability> {
    match sourced_oids(provenance).len() {
        0 => Some(ResultEditability::not_editable(
            EditBlockReason::NoBaseTable,
        )),
        1 => None,
        _ => Some(ResultEditability::not_editable(
            EditBlockReason::MultipleTables,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> Option<ResolvedRelation> {
        Some(ResolvedRelation {
            schema: "public".into(),
            relation: "users".into(),
            relkind: "r".into(),
        })
    }

    fn src(names: &[Option<&str>]) -> Vec<Option<String>> {
        names.iter().map(|n| n.map(String::from)).collect()
    }

    fn pk(cols: &[&str]) -> Vec<String> {
        cols.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_relation_is_no_base_table() {
        let got = decide(None, &src(&[None]), None, BTreeMap::new());
        assert_eq!(
            got,
            ResultEditability::not_editable(EditBlockReason::NoBaseTable)
        );
    }

    #[test]
    fn all_computed_columns_is_no_base_table() {
        let got = decide(
            table(),
            &src(&[None, None]),
            Some(&pk(&["id"])),
            BTreeMap::new(),
        );
        assert_eq!(
            got,
            ResultEditability::not_editable(EditBlockReason::NoBaseTable)
        );
    }

    #[test]
    fn view_is_not_a_table() {
        let view = Some(ResolvedRelation {
            schema: "public".into(),
            relation: "active_users".into(),
            relkind: "v".into(),
        });
        let got = decide(
            view,
            &src(&[Some("id")]),
            Some(&pk(&["id"])),
            BTreeMap::new(),
        );
        assert_eq!(
            got,
            ResultEditability::not_editable(EditBlockReason::NotATable)
        );
    }

    #[test]
    fn materialized_view_and_foreign_table_are_not_tables() {
        for kind in ["m", "f", "i", "S"] {
            let rel = Some(ResolvedRelation {
                schema: "public".into(),
                relation: "x".into(),
                relkind: kind.into(),
            });
            let got = decide(
                rel,
                &src(&[Some("id")]),
                Some(&pk(&["id"])),
                BTreeMap::new(),
            );
            assert_eq!(
                got,
                ResultEditability::not_editable(EditBlockReason::NotATable),
                "relkind {kind} must not be editable"
            );
        }
    }

    #[test]
    fn partitioned_table_is_editable() {
        let rel = Some(ResolvedRelation {
            schema: "public".into(),
            relation: "events".into(),
            relkind: "p".into(),
        });
        let got = decide(
            rel,
            &src(&[Some("id")]),
            Some(&pk(&["id"])),
            BTreeMap::new(),
        );
        assert!(matches!(got, ResultEditability::Editable { .. }));
    }

    #[test]
    fn duplicate_projection_is_rejected() {
        let got = decide(
            table(),
            &src(&[Some("id"), Some("id"), Some("email")]),
            Some(&pk(&["id"])),
            BTreeMap::new(),
        );
        assert_eq!(
            got,
            ResultEditability::not_editable(EditBlockReason::DuplicateProjection)
        );
    }

    #[test]
    fn two_computed_columns_are_not_duplicates() {
        let got = decide(
            table(),
            &src(&[Some("id"), None, None]),
            Some(&pk(&["id"])),
            BTreeMap::new(),
        );
        match got {
            ResultEditability::Editable { column_sources, .. } => {
                assert_eq!(column_sources, src(&[Some("id"), None, None]));
            }
            other => panic!("expected editable, got {other:?}"),
        }
    }

    #[test]
    fn missing_pk_is_no_primary_key() {
        let got = decide(table(), &src(&[Some("email")]), None, BTreeMap::new());
        assert_eq!(
            got,
            ResultEditability::not_editable(EditBlockReason::NoPrimaryKey)
        );
        let got = decide(table(), &src(&[Some("email")]), Some(&[]), BTreeMap::new());
        assert_eq!(
            got,
            ResultEditability::not_editable(EditBlockReason::NoPrimaryKey)
        );
    }

    #[test]
    fn unprojected_pk_is_pk_not_selected() {
        let got = decide(
            table(),
            &src(&[Some("email")]),
            Some(&pk(&["id"])),
            BTreeMap::new(),
        );
        assert_eq!(
            got,
            ResultEditability::not_editable(EditBlockReason::PkNotSelected)
        );
    }

    #[test]
    fn partially_projected_composite_pk_is_pk_not_selected() {
        let got = decide(
            table(),
            &src(&[Some("tenant_id"), Some("name")]),
            Some(&pk(&["tenant_id", "user_id"])),
            BTreeMap::new(),
        );
        assert_eq!(
            got,
            ResultEditability::not_editable(EditBlockReason::PkNotSelected)
        );
    }

    #[test]
    fn simple_projection_is_editable() {
        let got = decide(
            table(),
            &src(&[Some("id"), Some("email")]),
            Some(&pk(&["id"])),
            BTreeMap::new(),
        );
        match got {
            ResultEditability::Editable {
                schema,
                relation,
                pk_columns,
                pk_column_indexes,
                column_sources,
                enums,
            } => {
                assert_eq!(schema, "public");
                assert_eq!(relation, "users");
                assert_eq!(pk_columns, pk(&["id"]));
                assert_eq!(pk_column_indexes, vec![0]);
                assert_eq!(column_sources, src(&[Some("id"), Some("email")]));
                assert!(enums.is_empty());
            }
            other => panic!("expected editable, got {other:?}"),
        }
    }

    #[test]
    fn aliased_projection_reports_base_column_names() {
        // SELECT id AS pk, email AS mail FROM users
        let got = decide(
            table(),
            &src(&[Some("id"), Some("email")]),
            Some(&pk(&["id"])),
            BTreeMap::new(),
        );
        match got {
            ResultEditability::Editable {
                column_sources,
                pk_column_indexes,
                ..
            } => {
                assert_eq!(column_sources, src(&[Some("id"), Some("email")]));
                assert_eq!(pk_column_indexes, vec![0]);
            }
            other => panic!("expected editable, got {other:?}"),
        }
    }

    #[test]
    fn composite_pk_indexes_follow_declared_order_not_projection_order() {
        // SELECT user_id, tenant_id, name — PK declared (tenant_id, user_id).
        let got = decide(
            table(),
            &src(&[Some("user_id"), Some("tenant_id"), Some("name")]),
            Some(&pk(&["tenant_id", "user_id"])),
            BTreeMap::new(),
        );
        match got {
            ResultEditability::Editable {
                pk_columns,
                pk_column_indexes,
                ..
            } => {
                assert_eq!(pk_columns, pk(&["tenant_id", "user_id"]));
                assert_eq!(pk_column_indexes, vec![1, 0]);
            }
            other => panic!("expected editable, got {other:?}"),
        }
    }

    #[test]
    fn enums_are_carried_through_keyed_by_base_column() {
        let mut enums = BTreeMap::new();
        enums.insert(
            "status".to_string(),
            vec!["new".to_string(), "active".to_string()],
        );
        let got = decide(
            table(),
            &src(&[Some("id"), Some("status")]),
            Some(&pk(&["id"])),
            enums,
        );
        match got {
            ResultEditability::Editable { enums, .. } => {
                assert_eq!(enums.get("status").unwrap().len(), 2);
                assert!(!enums.contains_key("s"), "alias must not be a key");
            }
            other => panic!("expected editable, got {other:?}"),
        }
    }

    #[test]
    fn serializes_with_status_tag() {
        let editable = decide(
            table(),
            &src(&[Some("id"), Some("email")]),
            Some(&pk(&["id"])),
            BTreeMap::new(),
        );
        let json = serde_json::to_value(&editable).unwrap();
        assert_eq!(json.get("status").unwrap(), "editable");
        assert_eq!(json.get("schema").unwrap(), "public");
        assert_eq!(json.get("relation").unwrap(), "users");
        assert_eq!(
            json.get("pk_column_indexes")
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );

        let blocked = ResultEditability::not_editable(EditBlockReason::PkNotSelected);
        let json = serde_json::to_value(&blocked).unwrap();
        assert_eq!(json.get("status").unwrap(), "not_editable");
        assert_eq!(json.get("reason").unwrap(), "pk_not_selected");
    }

    #[test]
    fn every_block_reason_serializes_snake_case() {
        let cases = [
            (EditBlockReason::NoBaseTable, "no_base_table"),
            (EditBlockReason::MultipleTables, "multiple_tables"),
            (EditBlockReason::NotATable, "not_a_table"),
            (EditBlockReason::NoPrimaryKey, "no_primary_key"),
            (EditBlockReason::PkNotSelected, "pk_not_selected"),
            (EditBlockReason::DuplicateProjection, "duplicate_projection"),
        ];
        for (reason, expected) in cases {
            let json = serde_json::to_value(ResultEditability::not_editable(reason)).unwrap();
            assert_eq!(json.get("reason").unwrap(), expected);
        }
    }

    // ----------------------------------------------------------------------
    // Short-circuit coverage (task 2.6).
    //
    // `resolve` takes a live `PgObject`, which cannot be constructed in a unit
    // test. The short-circuit decision is therefore factored into a pure
    // helper and asserted here; `resolve` calls the same helper before it
    // touches the client, so "returns Some" is exactly "issues zero queries".
    // ----------------------------------------------------------------------

    fn prov(pairs: &[(Option<u32>, Option<i16>)]) -> Vec<ColumnProvenance> {
        pairs
            .iter()
            .map(|(table_oid, attnum)| ColumnProvenance {
                table_oid: *table_oid,
                attnum: *attnum,
            })
            .collect()
    }

    #[test]
    fn no_provenance_short_circuits_without_a_query() {
        let p = prov(&[(None, None), (None, None)]);
        assert_eq!(
            short_circuit(&p),
            Some(ResultEditability::not_editable(
                EditBlockReason::NoBaseTable
            ))
        );
    }

    #[test]
    fn multiple_oids_short_circuit_without_a_query() {
        let p = prov(&[(Some(16385), Some(1)), (Some(16390), Some(2))]);
        assert_eq!(
            short_circuit(&p),
            Some(ResultEditability::not_editable(
                EditBlockReason::MultipleTables
            ))
        );
    }

    #[test]
    fn single_oid_does_not_short_circuit() {
        let p = prov(&[(Some(16385), Some(1)), (Some(16385), Some(2)), (None, None)]);
        assert_eq!(short_circuit(&p), None);
    }

    #[test]
    fn system_column_attnum_is_not_sourced() {
        // attnum <= 0 is a system column (ctid, xmin) — never a writable
        // projection, so it must not keep a result alive on its own.
        let p = prov(&[(Some(16385), Some(0)), (Some(16385), None)]);
        assert_eq!(
            short_circuit(&p),
            Some(ResultEditability::not_editable(
                EditBlockReason::NoBaseTable
            ))
        );
    }
}
