//! DDL reconstruction for the Structure / Raw subtab. The output is a
//! human-readable, copy-pasteable SQL block — not byte-identical to
//! `pg_dump`. The goal is "I can recreate this relation on another database
//! with the same shape", not parity with the upstream tool.

use crate::modules::postgres::schema_types::{
    CheckConstraintInfo, ColumnDetail, FkAction, ForeignKeyInfo, PrimaryKeyInfo,
    UniqueConstraintInfo,
};

/// Quote a Postgres identifier with the standard double-quote-doubling rule.
pub fn quote_ident(s: &str) -> String {
    let escaped = s.replace('"', "\"\"");
    format!("\"{escaped}\"")
}

/// Escape a Postgres string literal — single-quote doubling, no E'…' prefix.
pub fn escape_sql_string(s: &str) -> String {
    s.replace('\'', "''")
}

fn fk_action_sql(a: FkAction) -> &'static str {
    match a {
        FkAction::NoAction => "NO ACTION",
        FkAction::Restrict => "RESTRICT",
        FkAction::Cascade => "CASCADE",
        FkAction::SetNull => "SET NULL",
        FkAction::SetDefault => "SET DEFAULT",
    }
}

fn quoted_columns(cols: &[String]) -> String {
    cols.iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Reconstruct a `CREATE TABLE` block followed by `CREATE INDEX` lines and
/// `COMMENT ON COLUMN` statements per the spec. `index_defs` carries one
/// pre-rendered `pg_get_indexdef` statement per non-PK index — the caller
/// is responsible for filtering out the PK index before passing them in.
#[allow(clippy::too_many_arguments)]
pub fn reconstruct_table(
    schema: &str,
    relation: &str,
    columns: &[ColumnDetail],
    primary_key: Option<&PrimaryKeyInfo>,
    foreign_keys: &[ForeignKeyInfo],
    unique_constraints: &[UniqueConstraintInfo],
    check_constraints: &[CheckConstraintInfo],
    index_defs: &[String],
) -> String {
    let qschema = quote_ident(schema);
    let qrelation = quote_ident(relation);
    let mut out = String::new();

    out.push_str(&format!("CREATE TABLE {qschema}.{qrelation} (\n"));

    // Column lines + table-level constraints, joined as ",\n".
    let mut body_lines: Vec<String> = Vec::new();

    for col in columns {
        let mut line = format!("    {} {}", quote_ident(&col.name), col.data_type);
        if !col.is_nullable {
            line.push_str(" NOT NULL");
        }
        if col.is_identity {
            // Identity columns never carry an emitted DEFAULT — the catalog
            // surfaces both, but they are mutually expressive.
            line.push_str(" GENERATED ALWAYS AS IDENTITY");
        } else if let Some(default) = &col.default {
            if col.is_generated {
                line.push_str(&format!(" GENERATED ALWAYS AS ({default}) STORED"));
            } else {
                line.push_str(&format!(" DEFAULT {default}"));
            }
        }
        body_lines.push(line);
    }

    if let Some(pk) = primary_key {
        body_lines.push(format!(
            "    CONSTRAINT {} PRIMARY KEY ({})",
            quote_ident(&pk.name),
            quoted_columns(&pk.columns)
        ));
    }

    for uq in unique_constraints {
        body_lines.push(format!(
            "    CONSTRAINT {} UNIQUE ({})",
            quote_ident(&uq.name),
            quoted_columns(&uq.columns)
        ));
    }

    for chk in check_constraints {
        body_lines.push(format!(
            "    CONSTRAINT {} CHECK {}",
            quote_ident(&chk.name),
            chk.expression
        ));
    }

    for fk in foreign_keys {
        let mut line = format!(
            "    CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}.{} ({})",
            quote_ident(&fk.name),
            quoted_columns(&fk.columns),
            quote_ident(&fk.references.schema),
            quote_ident(&fk.references.relation),
            quoted_columns(&fk.references.columns),
        );
        if !matches!(fk.on_delete, FkAction::NoAction) {
            line.push_str(&format!(" ON DELETE {}", fk_action_sql(fk.on_delete)));
        }
        if !matches!(fk.on_update, FkAction::NoAction) {
            line.push_str(&format!(" ON UPDATE {}", fk_action_sql(fk.on_update)));
        }
        if fk.deferrable {
            line.push_str(" DEFERRABLE");
            if fk.initially_deferred {
                line.push_str(" INITIALLY DEFERRED");
            }
        }
        body_lines.push(line);
    }

    out.push_str(&body_lines.join(",\n"));
    out.push('\n');
    out.push_str(");\n");

    // Each entry in `index_defs` is already a complete `CREATE [UNIQUE] INDEX
    // ... ON ... USING ... (...);` statement from `pg_get_indexdef`. The
    // caller filters out the PK index before passing them in.
    for def in index_defs {
        let trimmed = def.trim_end_matches(';').trim_end();
        out.push('\n');
        out.push_str(trimmed);
        out.push_str(";");
    }

    // Column comments
    for col in columns {
        if let Some(comment) = &col.comment {
            out.push_str(&format!(
                "\nCOMMENT ON COLUMN {}.{}.{} IS '{}';",
                qschema,
                qrelation,
                quote_ident(&col.name),
                escape_sql_string(comment),
            ));
        }
    }

    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// Compose the view DDL. `body` is the result of `pg_get_viewdef(oid, true)`.
pub fn reconstruct_view(schema: &str, relation: &str, body: &str) -> String {
    format!(
        "CREATE OR REPLACE VIEW {}.{} AS\n{}\n",
        quote_ident(schema),
        quote_ident(relation),
        body.trim_end(),
    )
}

/// Compose the materialized-view DDL. `body` is the result of
/// `pg_get_viewdef(oid, true)`. The trailing `WITH DATA;` / `WITH NO DATA;`
/// reflects whether the matview is currently populated.
pub fn reconstruct_matview(schema: &str, relation: &str, body: &str, is_populated: bool) -> String {
    let suffix = if is_populated {
        "WITH DATA"
    } else {
        "WITH NO DATA"
    };
    format!(
        "CREATE MATERIALIZED VIEW {}.{} AS\n{}\n{};\n",
        quote_ident(schema),
        quote_ident(relation),
        body.trim_end(),
        suffix,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::postgres::schema_types::ForeignKeyRef;

    fn col(
        name: &str,
        data_type: &str,
        is_nullable: bool,
        default: Option<&str>,
        ord: i32,
    ) -> ColumnDetail {
        ColumnDetail {
            name: name.into(),
            data_type: data_type.into(),
            is_nullable,
            default: default.map(|s| s.into()),
            ordinal_position: ord,
            comment: None,
            is_identity: false,
            is_generated: false,
        }
    }

    #[test]
    fn quote_ident_doubles_internal_quotes() {
        assert_eq!(quote_ident("simple"), "\"simple\"");
        assert_eq!(quote_ident("we\"ird"), "\"we\"\"ird\"");
    }

    #[test]
    fn escape_sql_string_doubles_quotes() {
        assert_eq!(escape_sql_string("plain"), "plain");
        assert_eq!(escape_sql_string("it's"), "it''s");
    }

    #[test]
    fn plain_table_reconstructs_with_pk_and_fk() {
        let columns = vec![
            col("id", "bigint", false, None, 1),
            col("customer_id", "bigint", false, None, 2),
            col("total", "numeric(10,2)", true, None, 3),
        ];
        let pk = PrimaryKeyInfo {
            name: "orders_pkey".into(),
            columns: vec!["id".into()],
        };
        let fk = ForeignKeyInfo {
            name: "orders_customer_id_fkey".into(),
            columns: vec!["customer_id".into()],
            references: ForeignKeyRef {
                schema: "public".into(),
                relation: "customers".into(),
                columns: vec!["id".into()],
            },
            on_update: FkAction::NoAction,
            on_delete: FkAction::Cascade,
            deferrable: false,
            initially_deferred: false,
        };
        let pk_ref = pk.clone();
        let fks = vec![fk];
        // Caller has already filtered out the PK index; we only pass non-PK
        // index DDL statements.
        let index_defs = vec![
            "CREATE INDEX \"orders_created_at_idx\" ON \"public\".\"orders\" USING btree (\"created_at\")".to_string(),
        ];
        let ddl = reconstruct_table(
            "public",
            "orders",
            &columns,
            Some(&pk_ref),
            &fks,
            &[],
            &[],
            &index_defs,
        );

        assert!(ddl.starts_with("CREATE TABLE \"public\".\"orders\" (\n"));
        assert!(ddl.contains("\"id\" bigint NOT NULL"));
        assert!(ddl.contains("CONSTRAINT \"orders_pkey\" PRIMARY KEY (\"id\")"));
        assert!(ddl.contains(
            "FOREIGN KEY (\"customer_id\") REFERENCES \"public\".\"customers\" (\"id\") \
             ON DELETE CASCADE"
        ));
        assert!(ddl.contains(");\n"));
        assert!(ddl.contains("CREATE INDEX \"orders_created_at_idx\" ON \"public\".\"orders\""));
    }

    #[test]
    fn identity_column_emits_generated_always_as_identity() {
        let mut id_col = col("id", "bigint", false, Some("nextval('seq')"), 1);
        id_col.is_identity = true;
        let ddl = reconstruct_table("public", "t", &[id_col], None, &[], &[], &[], &[]);
        assert!(ddl.contains("\"id\" bigint NOT NULL GENERATED ALWAYS AS IDENTITY"));
        // No DEFAULT clause when identity is set
        assert!(!ddl.contains("DEFAULT nextval"));
    }

    #[test]
    fn column_comment_emits_comment_on_column() {
        let mut c = col("email", "text", true, None, 1);
        c.comment = Some("primary contact".into());
        let ddl = reconstruct_table("public", "users", &[c], None, &[], &[], &[], &[]);
        assert!(ddl.contains("COMMENT ON COLUMN \"public\".\"users\".\"email\" IS 'primary contact';"));
    }

    #[test]
    fn comment_with_single_quote_is_escaped() {
        let mut c = col("note", "text", true, None, 1);
        c.comment = Some("it's".into());
        let ddl = reconstruct_table("public", "t", &[c], None, &[], &[], &[], &[]);
        assert!(ddl.contains("IS 'it''s';"));
    }

    #[test]
    fn view_ddl_uses_create_or_replace_view() {
        let ddl = reconstruct_view("public", "active_users", " SELECT id, name FROM users\n  WHERE deleted_at IS NULL;");
        assert!(ddl.starts_with("CREATE OR REPLACE VIEW \"public\".\"active_users\" AS\n"));
        assert!(ddl.ends_with(";\n"));
    }

    #[test]
    fn matview_unpopulated_appends_with_no_data() {
        let ddl = reconstruct_matview("public", "stats", " SELECT 1;", false);
        assert!(ddl.starts_with("CREATE MATERIALIZED VIEW \"public\".\"stats\" AS\n"));
        assert!(ddl.ends_with("WITH NO DATA;\n"));
    }

    #[test]
    fn matview_populated_appends_with_data() {
        let ddl = reconstruct_matview("public", "stats", " SELECT 1;", true);
        assert!(ddl.ends_with("WITH DATA;\n"));
    }

    #[test]
    fn quoted_identifier_with_double_quote_is_doubled_in_ddl() {
        let cols = vec![col("id", "bigint", false, None, 1)];
        let ddl = reconstruct_table("public", "we\"ird", &cols, None, &[], &[], &[], &[]);
        assert!(ddl.contains("\"we\"\"ird\""));
    }
}
