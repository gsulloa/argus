use async_trait::async_trait;
use aws_sdk_glue::error::ProvideErrorMetadata;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::athena::pool::AthenaClientRegistry;
use crate::modules::athena::schema_commands::fetch_table_columns;
use crate::modules::cloudwatch::client::CloudwatchClientRegistry;
use crate::modules::cloudwatch::errors::sdk_err_to_app as cw_sdk_err_to_app;
use crate::modules::context::engine::EngineKind;
use crate::modules::context::introspect::{IntrospectForContext, ObjectShape, ObjectShapeColumn};
use crate::modules::dynamo::client::DynamoClientRegistry;
use crate::modules::dynamo::tables::describe::describe_table;
use crate::modules::dynamo::tables::list::{run_pager, DynamoPageProvider};
use crate::modules::dynamo::tables::types::{AttributeType, KeyType};
use crate::modules::mssql::pool::MssqlPoolRegistry;
use crate::modules::mssql::schema_commands::{
    list_relations_for_pool as mssql_list_relations_for_pool,
    list_schemas_for_pool as mssql_list_schemas_for_pool,
    list_structure_for_pool as mssql_list_structure_for_pool,
};
use crate::modules::mysql::pool::MysqlPoolRegistry;
use crate::modules::mysql::schema_commands::{
    list_relations_for_pool as mysql_list_relations_for_pool,
    list_schemas_for_pool as mysql_list_schemas_for_pool,
    list_structure_for_pool as mysql_list_structure_for_pool,
};
use crate::modules::postgres::pool::PgPoolRegistry;
use crate::modules::postgres::schema;

// ---------------------------------------------------------------------------
// §2.1 — IntrospectorPools bundle
// ---------------------------------------------------------------------------

pub struct IntrospectorPools<'a> {
    pub pg: &'a PgPoolRegistry,
    pub mysql: &'a MysqlPoolRegistry,
    pub mssql: &'a MssqlPoolRegistry,
    pub dynamo: &'a DynamoClientRegistry,
    pub athena: &'a AthenaClientRegistry,
    pub cloudwatch: &'a CloudwatchClientRegistry,
}

// ---- Postgres adapter ----

pub struct PostgresIntrospector<'a> {
    pub pool: &'a PgPoolRegistry,
}

#[async_trait]
impl<'a> IntrospectForContext for PostgresIntrospector<'a> {
    async fn introspect_for_context(&self, conn_id: Uuid) -> AppResult<Vec<ObjectShape>> {
        // Acquire one connection from the pool for the duration of the introspection.
        let client = self.pool.acquire(&conn_id).await?;

        // List all schemas; skip system schemas.
        let schemas = schema::list_schemas(&client).await?;
        let user_schemas: Vec<_> = schemas.into_iter().filter(|s| !s.is_system).collect();

        let mut shapes: Vec<ObjectShape> = Vec::new();

        for schema_info in user_schemas {
            let schema_name = &schema_info.name;

            // list_relations returns (tables, views, materialized_views).
            let (tables, views, mat_views) =
                match schema::list_relations(&client, schema_name).await {
                    Ok(r) => r,
                    Err(e) => {
                        tracing::warn!(
                            schema = %schema_name,
                            "context sync: failed to list relations: {e}"
                        );
                        continue;
                    }
                };

            // Collect all relations with their kind string.
            let mut relations: Vec<(String, String)> = Vec::new(); // (kind, name)
            for t in &tables {
                relations.push(("table".to_string(), t.name.clone()));
            }
            for v in &views {
                relations.push(("view".to_string(), v.name.clone()));
            }
            for mv in &mat_views {
                relations.push(("materialized_view".to_string(), mv.name.clone()));
            }

            for (kind, rel_name) in relations {
                // Fetch columns — skip the whole relation on error (permission denied, etc.)
                let columns = match schema::list_table_columns_detailed(
                    &client,
                    schema_name,
                    &rel_name,
                )
                .await
                {
                    Ok(cols) => cols
                        .into_iter()
                        .map(|c| ObjectShapeColumn {
                            name: c.name,
                            ty: c.data_type,
                        })
                        .collect(),
                    Err(e) => {
                        tracing::warn!(
                            schema = %schema_name,
                            relation = %rel_name,
                            "context sync: failed to list columns: {e}"
                        );
                        continue;
                    }
                };

                // Fetch primary key — empty Vec if absent or error.
                let primary_key =
                    match schema::get_primary_key(&client, schema_name, &rel_name).await {
                        Ok(Some(pk)) => pk.columns,
                        Ok(None) => vec![],
                        Err(e) => {
                            tracing::warn!(
                                schema = %schema_name,
                                relation = %rel_name,
                                "context sync: failed to get primary key: {e}"
                            );
                            vec![]
                        }
                    };

                shapes.push(ObjectShape {
                    kind,
                    schema: Some(schema_name.clone()),
                    name: rel_name,
                    primary_key,
                    columns,
                });
            }
        }

        Ok(shapes)
    }
}

// ---- MySQL adapter ----

pub struct MysqlIntrospector<'a> {
    pub pool: &'a MysqlPoolRegistry,
}

#[async_trait]
impl<'a> IntrospectForContext for MysqlIntrospector<'a> {
    async fn introspect_for_context(&self, conn_id: Uuid) -> AppResult<Vec<ObjectShape>> {
        let pool = self.pool.acquire(conn_id)?;

        let all_schemas = mysql_list_schemas_for_pool(&pool).await?;
        let user_schemas: Vec<_> = all_schemas.into_iter().filter(|s| !s.is_system).collect();

        let mut shapes: Vec<ObjectShape> = Vec::new();

        for schema_info in user_schemas {
            let schema_name = &schema_info.name;

            let relations_result = match mysql_list_relations_for_pool(&pool, schema_name).await {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!(
                        target: "argus::context",
                        schema = %schema_name,
                        "context sync (mysql): failed to list relations: {e}"
                    );
                    continue;
                }
            };

            // tables + views
            let mut relation_pairs: Vec<(String, String)> = Vec::new();
            for t in &relations_result.tables {
                relation_pairs.push(("table".to_string(), t.name.clone()));
            }
            for v in &relations_result.views {
                relation_pairs.push(("view".to_string(), v.name.clone()));
            }

            for (kind, rel_name) in relation_pairs {
                let (col_rows, pk_cols) =
                    match mysql_list_structure_for_pool(&pool, schema_name, &rel_name).await {
                        Ok(r) => r,
                        Err(e) => {
                            tracing::warn!(
                                target: "argus::context",
                                schema = %schema_name,
                                relation = %rel_name,
                                "context sync (mysql): failed to list structure: {e}"
                            );
                            continue;
                        }
                    };

                let columns: Vec<ObjectShapeColumn> = col_rows
                    .into_iter()
                    .map(|(name, ty)| ObjectShapeColumn { name, ty })
                    .collect();

                // Views have no PK.
                let primary_key = if kind == "view" { vec![] } else { pk_cols };

                shapes.push(ObjectShape {
                    kind,
                    schema: Some(schema_name.clone()),
                    name: rel_name,
                    primary_key,
                    columns,
                });
            }
        }

        Ok(shapes)
    }
}

// ---- MSSQL adapter ----

pub struct MssqlIntrospector<'a> {
    pub pool: &'a MssqlPoolRegistry,
}

#[async_trait]
impl<'a> IntrospectForContext for MssqlIntrospector<'a> {
    async fn introspect_for_context(&self, conn_id: Uuid) -> AppResult<Vec<ObjectShape>> {
        let pool = self.pool.get_pool(conn_id)?;

        let all_schemas = mssql_list_schemas_for_pool(&pool).await?;
        // Filter: exclude system schemas and db_* prefix schemas
        let user_schemas: Vec<_> = all_schemas
            .into_iter()
            .filter(|s| !s.is_system && !s.name.starts_with("db_") && s.name != "guest")
            .collect();

        let mut shapes: Vec<ObjectShape> = Vec::new();

        for schema_info in user_schemas {
            let schema_name = &schema_info.name;

            let relations_result = match mssql_list_relations_for_pool(&pool, schema_name).await {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!(
                        target: "argus::context",
                        schema = %schema_name,
                        "context sync (mssql): failed to list relations: {e}"
                    );
                    continue;
                }
            };

            let mut relation_pairs: Vec<(String, String)> = Vec::new();
            for t in &relations_result.tables {
                relation_pairs.push(("table".to_string(), t.name.clone()));
            }
            for v in &relations_result.views {
                relation_pairs.push(("view".to_string(), v.name.clone()));
            }

            for (kind, rel_name) in relation_pairs {
                let (col_rows, pk_cols) =
                    match mssql_list_structure_for_pool(&pool, schema_name, &rel_name).await {
                        Ok(r) => r,
                        Err(e) => {
                            tracing::warn!(
                                target: "argus::context",
                                schema = %schema_name,
                                relation = %rel_name,
                                "context sync (mssql): failed to list structure: {e}"
                            );
                            continue;
                        }
                    };

                let columns: Vec<ObjectShapeColumn> = col_rows
                    .into_iter()
                    .map(|(name, ty)| ObjectShapeColumn { name, ty })
                    .collect();

                let primary_key = if kind == "view" { vec![] } else { pk_cols };

                shapes.push(ObjectShape {
                    kind,
                    schema: Some(schema_name.clone()),
                    name: rel_name,
                    primary_key,
                    columns,
                });
            }
        }

        Ok(shapes)
    }
}

// ---- Dynamo adapter ----

pub struct DynamoIntrospector<'a> {
    pub registry: &'a DynamoClientRegistry,
}

#[async_trait]
impl<'a> IntrospectForContext for DynamoIntrospector<'a> {
    async fn introspect_for_context(&self, conn_id: Uuid) -> AppResult<Vec<ObjectShape>> {
        let client = self.registry.acquire(&conn_id).await?;

        // Enumerate all table names using the pager (cap = 10_000 to be safe).
        let provider = DynamoPageProvider {
            client: client.clone(),
        };
        let list_result = run_pager(&provider, None, 10_000).await?;
        let table_names = list_result.tables;

        let mut shapes: Vec<ObjectShape> = Vec::new();

        for table_name in table_names {
            let desc = match describe_table(&client, &table_name).await {
                Ok(d) => d,
                Err(e) => {
                    tracing::warn!(
                        target: "argus::context",
                        table = %table_name,
                        "context sync (dynamo): failed to describe table: {e}"
                    );
                    continue;
                }
            };

            // Build primary_key: HASH first, then RANGE (if present).
            let mut primary_key: Vec<String> = Vec::new();
            // Sort: HASH before RANGE
            let mut hash_key: Option<String> = None;
            let mut range_key: Option<String> = None;
            for ks in &desc.key_schema {
                match ks.key_type {
                    KeyType::Hash => hash_key = Some(ks.attribute_name.clone()),
                    KeyType::Range => range_key = Some(ks.attribute_name.clone()),
                }
            }
            if let Some(h) = hash_key {
                primary_key.push(h);
            }
            if let Some(r) = range_key {
                primary_key.push(r);
            }

            // Columns: attribute_definitions mapped to {name, ty: "S"|"N"|"B"}
            let columns: Vec<ObjectShapeColumn> = desc
                .attribute_definitions
                .into_iter()
                .map(|ad| ObjectShapeColumn {
                    name: ad.attribute_name,
                    ty: match ad.attribute_type {
                        AttributeType::S => "S".to_string(),
                        AttributeType::N => "N".to_string(),
                        AttributeType::B => "B".to_string(),
                    },
                })
                .collect();

            shapes.push(ObjectShape {
                kind: "dynamo_table".to_string(),
                schema: None,
                name: table_name,
                primary_key,
                columns,
            });
        }

        Ok(shapes)
    }
}

// ---- Athena adapter ----

pub struct AthenaIntrospector<'a> {
    pub registry: &'a AthenaClientRegistry,
}

#[async_trait]
impl<'a> IntrospectForContext for AthenaIntrospector<'a> {
    async fn introspect_for_context(&self, conn_id: Uuid) -> AppResult<Vec<ObjectShape>> {
        let acquired = self.registry.acquire(&conn_id).await?;
        let glue = &acquired.glue;

        let mut shapes: Vec<ObjectShape> = Vec::new();

        // Enumerate all Glue databases.
        let mut db_next_token: Option<String> = None;
        loop {
            let db_resp = glue
                .get_databases()
                .set_next_token(db_next_token)
                .send()
                .await
                .map_err(|e| {
                    AppError::aws(
                        e.meta().code().unwrap_or("Unknown").to_string(),
                        e.meta()
                            .message()
                            .map(String::from)
                            .unwrap_or_else(|| format!("{e:?}")),
                        false,
                    )
                })?;

            for db in db_resp.database_list() {
                let database_name = db.name().to_string();

                // Enumerate all tables in this database.
                let mut tbl_next_token: Option<String> = None;
                loop {
                    let tbl_resp = match glue
                        .get_tables()
                        .database_name(&database_name)
                        .set_next_token(tbl_next_token)
                        .send()
                        .await
                    {
                        Ok(r) => r,
                        Err(e) => {
                            tracing::warn!(
                                target: "argus::context",
                                database = %database_name,
                                "context sync (athena): failed to list tables: {:?}", e
                            );
                            break;
                        }
                    };

                    for table in tbl_resp.table_list() {
                        let kind = if table.table_type() == Some("VIRTUAL_VIEW") {
                            "view".to_string()
                        } else {
                            "table".to_string()
                        };
                        let table_name = table.name().to_string();

                        // Fetch columns.
                        let col_entries =
                            match fetch_table_columns(glue, &database_name, &table_name).await {
                                Ok(c) => c,
                                Err(e) => {
                                    tracing::warn!(
                                        target: "argus::context",
                                        database = %database_name,
                                        table = %table_name,
                                        "context sync (athena): failed to list columns: {e}"
                                    );
                                    continue;
                                }
                            };

                        let columns: Vec<ObjectShapeColumn> = col_entries
                            .into_iter()
                            .map(|c| ObjectShapeColumn {
                                name: c.name,
                                ty: c.ty,
                            })
                            .collect();

                        shapes.push(ObjectShape {
                            kind,
                            schema: Some(database_name.clone()),
                            name: table_name.clone(),
                            primary_key: vec![],
                            columns,
                        });
                    }

                    tbl_next_token = tbl_resp.next_token().map(str::to_string);
                    if tbl_next_token.is_none() {
                        break;
                    }
                }
            }

            db_next_token = db_resp.next_token().map(str::to_string);
            if db_next_token.is_none() {
                break;
            }
        }

        Ok(shapes)
    }
}

// ---- CloudWatch Logs adapter ----

pub struct CloudwatchIntrospector<'a> {
    pub registry: &'a CloudwatchClientRegistry,
}

#[async_trait]
impl<'a> IntrospectForContext for CloudwatchIntrospector<'a> {
    async fn introspect_for_context(&self, conn_id: Uuid) -> AppResult<Vec<ObjectShape>> {
        let client = self.registry.acquire(&conn_id).await?;

        let mut shapes: Vec<ObjectShape> = Vec::new();
        let mut next_token: Option<String> = None;

        loop {
            let mut req = client.describe_log_groups().limit(50);
            if let Some(tok) = next_token {
                req = req.next_token(tok);
            }

            let resp = req.send().await.map_err(|e| cw_sdk_err_to_app(&e))?;

            for group in resp.log_groups() {
                let name = group.log_group_name().unwrap_or_default().to_string();
                if name.is_empty() {
                    continue;
                }
                shapes.push(ObjectShape {
                    kind: "log_group".to_string(),
                    schema: None,
                    name,
                    primary_key: vec![],
                    columns: vec![],
                });
            }

            next_token = resp.next_token().map(str::to_string);
            if next_token.is_none() {
                break;
            }
        }

        Ok(shapes)
    }
}

// ---- Not-yet-implemented stub ----

pub struct NotImplementedIntrospector {
    pub engine: EngineKind,
}

#[async_trait]
impl IntrospectForContext for NotImplementedIntrospector {
    async fn introspect_for_context(&self, _conn_id: Uuid) -> AppResult<Vec<ObjectShape>> {
        Err(AppError::Internal(format!(
            "schema sync not yet wired for kind '{}' — see tasks 6.2–6.3",
            self.engine.subtree()
        )))
    }
}

// ---- Dispatcher ----

/// §2.2 — Return the appropriate introspector for the given engine.
pub fn introspector_for<'a>(
    engine: EngineKind,
    pools: IntrospectorPools<'a>,
) -> Box<dyn IntrospectForContext + 'a> {
    match engine {
        EngineKind::Postgres => Box::new(PostgresIntrospector { pool: pools.pg }),
        EngineKind::Mysql => Box::new(MysqlIntrospector { pool: pools.mysql }),
        EngineKind::Mssql => Box::new(MssqlIntrospector { pool: pools.mssql }),
        EngineKind::Dynamo => Box::new(DynamoIntrospector {
            registry: pools.dynamo,
        }),
        EngineKind::Athena => Box::new(AthenaIntrospector {
            registry: pools.athena,
        }),
        EngineKind::Cloudwatch => Box::new(CloudwatchIntrospector {
            registry: pools.cloudwatch,
        }),
    }
}

// ---- tests ----

#[cfg(test)]
mod tests {
    use super::*;

    fn make_pools<'a>(
        pg: &'a PgPoolRegistry,
        mysql: &'a MysqlPoolRegistry,
        mssql: &'a MssqlPoolRegistry,
        dynamo: &'a DynamoClientRegistry,
        athena: &'a AthenaClientRegistry,
        cloudwatch: &'a CloudwatchClientRegistry,
    ) -> IntrospectorPools<'a> {
        IntrospectorPools {
            pg,
            mysql,
            mssql,
            dynamo,
            athena,
            cloudwatch,
        }
    }

    // §12.1 — introspector_for(Mysql/Mssql/Dynamo) does NOT return NotImplementedIntrospector.
    // We verify by calling introspect_for_context and asserting the error is NOT the
    // "not yet wired" message (it will be a NotFound error for unknown conn id instead).

    #[tokio::test]
    async fn mysql_introspector_is_not_not_implemented() {
        let pg = PgPoolRegistry::new();
        let mysql = MysqlPoolRegistry::new();
        let mssql = MssqlPoolRegistry::new();
        let dynamo = DynamoClientRegistry::new();
        let athena = AthenaClientRegistry::new();
        let cloudwatch = CloudwatchClientRegistry::new();
        let pools = make_pools(&pg, &mysql, &mssql, &dynamo, &athena, &cloudwatch);

        let adapter = introspector_for(EngineKind::Mysql, pools);
        let err = adapter
            .introspect_for_context(Uuid::nil())
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(
            !msg.contains("not yet wired"),
            "mysql adapter should not be NotImplemented; got: {msg}"
        );
    }

    #[tokio::test]
    async fn mssql_introspector_is_not_not_implemented() {
        let pg = PgPoolRegistry::new();
        let mysql = MysqlPoolRegistry::new();
        let mssql = MssqlPoolRegistry::new();
        let dynamo = DynamoClientRegistry::new();
        let athena = AthenaClientRegistry::new();
        let cloudwatch = CloudwatchClientRegistry::new();
        let pools = make_pools(&pg, &mysql, &mssql, &dynamo, &athena, &cloudwatch);

        let adapter = introspector_for(EngineKind::Mssql, pools);
        let err = adapter
            .introspect_for_context(Uuid::nil())
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(
            !msg.contains("not yet wired"),
            "mssql adapter should not be NotImplemented; got: {msg}"
        );
    }

    #[tokio::test]
    async fn dynamo_introspector_is_not_not_implemented() {
        let pg = PgPoolRegistry::new();
        let mysql = MysqlPoolRegistry::new();
        let mssql = MssqlPoolRegistry::new();
        let dynamo = DynamoClientRegistry::new();
        let athena = AthenaClientRegistry::new();
        let cloudwatch = CloudwatchClientRegistry::new();
        let pools = make_pools(&pg, &mysql, &mssql, &dynamo, &athena, &cloudwatch);

        let adapter = introspector_for(EngineKind::Dynamo, pools);
        let err = adapter
            .introspect_for_context(Uuid::nil())
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(
            !msg.contains("not yet wired"),
            "dynamo adapter should not be NotImplemented; got: {msg}"
        );
    }

    #[tokio::test]
    async fn athena_introspector_is_not_not_implemented() {
        let pg = PgPoolRegistry::new();
        let mysql = MysqlPoolRegistry::new();
        let mssql = MssqlPoolRegistry::new();
        let dynamo = DynamoClientRegistry::new();
        let athena = AthenaClientRegistry::new();
        let cloudwatch = CloudwatchClientRegistry::new();
        let pools = make_pools(&pg, &mysql, &mssql, &dynamo, &athena, &cloudwatch);

        let adapter = introspector_for(EngineKind::Athena, pools);
        let err = adapter
            .introspect_for_context(Uuid::nil())
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(
            !msg.contains("not yet wired"),
            "athena adapter should not be NotImplemented; got: {msg}"
        );
    }

    // §5.1 — Cloudwatch introspector dispatches to CloudwatchIntrospector (not NotImplemented).
    // With an empty registry (no active client), it returns NotFound — not an "not yet wired" error.
    #[tokio::test]
    async fn cloudwatch_introspector_is_not_not_implemented() {
        let pg = PgPoolRegistry::new();
        let mysql = MysqlPoolRegistry::new();
        let mssql = MssqlPoolRegistry::new();
        let dynamo = DynamoClientRegistry::new();
        let athena = AthenaClientRegistry::new();
        let cloudwatch = CloudwatchClientRegistry::new();
        let pools = make_pools(&pg, &mysql, &mssql, &dynamo, &athena, &cloudwatch);

        let adapter = introspector_for(EngineKind::Cloudwatch, pools);
        let err = adapter
            .introspect_for_context(Uuid::nil())
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(
            !msg.contains("not yet wired"),
            "cloudwatch adapter should not be NotImplemented; got: {msg}"
        );
        // It should be NotFound (no active client for Uuid::nil()).
        assert!(
            matches!(err, AppError::NotFound(_)),
            "cloudwatch adapter should return NotFound for unknown conn id; got: {msg}"
        );
    }

    #[tokio::test]
    async fn not_implemented_stub_returns_internal_error() {
        let stub = NotImplementedIntrospector {
            engine: EngineKind::Mysql,
        };
        let err = stub
            .introspect_for_context(Uuid::new_v4())
            .await
            .unwrap_err();
        match err {
            AppError::Internal(msg) => {
                assert!(
                    msg.contains("mysql"),
                    "error message should mention the engine, got: {msg}"
                );
                assert!(
                    msg.contains("6.2"),
                    "error message should reference tasks 6.2-6.3, got: {msg}"
                );
            }
            other => panic!("expected AppError::Internal, got: {other:?}"),
        }
    }
}
