/// Integration test: schema tree must not hang on reserved-word relation names.
///
/// Gated by `#[ignore]` and `TEST_PG_URL`. Run with:
///   TEST_PG_URL=postgres://... cargo test --test postgres_schema_extras -- --ignored
use std::time::Instant;
use tokio_postgres::NoTls;

// Inlined copies of the SQL constants from schema.rs — the integration test
// calls the DB directly via `tokio_postgres::Client` so it doesn't depend on
// the pool / PgObject abstraction.
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


#[tokio::test]
#[ignore]
async fn list_table_extras_reserved_word_table_completes() {
    let url = match std::env::var("TEST_PG_URL") {
        Ok(v) => v,
        Err(_) => {
            eprintln!("TEST_PG_URL not set — skipping");
            return;
        }
    };

    let (client, connection) = tokio_postgres::connect(&url, NoTls)
        .await
        .expect("connect to test postgres");

    // Drive the connection in the background.
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("postgres connection error: {e}");
        }
    });

    // Use a unique schema name to allow parallel / re-runnable test runs.
    let schema = format!(
        "argus_test_{}",
        &uuid::Uuid::new_v4().to_string().replace('-', "")[..8]
    );

    // --- Setup ---
    client
        .execute(&format!("CREATE SCHEMA {schema}"), &[])
        .await
        .expect("create schema");

    client
        .execute(
            &format!(
                r#"CREATE TABLE {schema}."order" (id int primary key, ts timestamptz)"#
            ),
            &[],
        )
        .await
        .expect("create table");

    client
        .execute(
            &format!(r#"CREATE INDEX ON {schema}."order" (ts)"#),
            &[],
        )
        .await
        .expect("create index");

    // Create a no-op trigger function, then a trigger that calls it.
    client
        .execute(
            &format!(
                r#"CREATE OR REPLACE FUNCTION {schema}.noop_trigger()
                   RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$"#
            ),
            &[],
        )
        .await
        .expect("create trigger function");

    client
        .execute(
            &format!(
                r#"CREATE TRIGGER before_insert_order
                   BEFORE INSERT ON {schema}."order"
                   FOR EACH ROW EXECUTE FUNCTION {schema}.noop_trigger()"#
            ),
            &[],
        )
        .await
        .expect("create trigger");

    // --- Exercise ---
    let started = Instant::now();

    let index_rows = client
        .query(SQL_LIST_TABLE_INDEXES, &[&schema.as_str(), &"order"])
        .await
        .expect("list_table_indexes query");

    let trigger_rows = client
        .query(SQL_LIST_TABLE_TRIGGERS, &[&schema.as_str(), &"order"])
        .await
        .expect("list_table_triggers query");

    let elapsed = started.elapsed();

    // --- Assertions ---
    assert_eq!(
        index_rows.len(),
        1,
        "expected exactly 1 non-primary index on \"order\"; got {}",
        index_rows.len()
    );

    assert_eq!(
        trigger_rows.len(),
        1,
        "expected exactly 1 trigger on \"order\"; got {}",
        trigger_rows.len()
    );

    assert!(
        elapsed.as_secs() < 5,
        "queries took {elapsed:?} — expected < 5s for a reserved-word table"
    );

    // Verify the index name is present and non-empty.
    let index_name: String = index_rows[0].get(0);
    assert!(
        !index_name.is_empty(),
        "index name should be non-empty"
    );

    // Verify the trigger name matches what we created.
    let trigger_name: String = trigger_rows[0].get(0);
    assert_eq!(trigger_name, "before_insert_order");

    // --- Teardown ---
    client
        .execute(&format!("DROP SCHEMA {schema} CASCADE"), &[])
        .await
        .expect("drop schema");
}
