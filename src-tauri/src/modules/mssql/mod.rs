// MS SQL Server support module. See openspec/changes/add-mssql-support/.

pub mod binding;
pub mod cancel;
pub mod columns;
pub mod commands;
pub mod data;
pub mod edit;
pub mod errors;
pub mod params;
pub mod pool;
pub mod schema_commands;
pub mod schema_types;
pub mod sql;
pub mod structure;
pub mod tls;
pub mod url;

pub use columns::mssql_list_columns_bulk;
pub use commands::{
    mssql_connect, mssql_disconnect, mssql_disconnect_all, mssql_list_active, mssql_parse_url,
    mssql_test_connection,
};
pub use data::{mssql_count_table, mssql_query_table};
pub use edit::{mssql_apply_table_edits, mssql_table_primary_key};
pub use params::{EncryptMode, MssqlParams};
pub use pool::{ActivePoolSummary, MssqlPoolRegistry};
pub use schema_commands::{
    mssql_get_object_definition, mssql_get_routine_signature, mssql_list_databases,
    mssql_list_relations, mssql_list_schemas, mssql_list_structure, mssql_list_table_extras,
};
pub use sql::{mssql_run_sql, mssql_run_sql_batch, mssql_run_sql_many};
pub use structure::{mssql_table_ddl, mssql_table_structure};
