// MySQL data-source module. Phased rollout via openspec change add-mysql-support.
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

pub use binding::{
    bind_edit_value, bind_filter_value, bind_kind_for_type, decode_row_value, mysql_quote_ident,
    mysql_quote_qualified, BindKind,
};
pub use cancel::{capture_thread_id, fire_mysql_cancel, with_mysql_timeout_and_cancel};
pub use columns::mysql_list_columns_bulk;
pub use commands::{
    mysql_connect, mysql_disconnect, mysql_disconnect_all, mysql_list_active, mysql_parse_url,
    mysql_test_connection,
};
pub use data::{mysql_count_table, mysql_query_table};
pub use edit::{mysql_apply_table_edits, mysql_table_primary_key};
pub use errors::map_sqlx_error;
pub use params::{MysqlParams, SslMode};
pub use pool::{ActiveMysqlPool, ActivePoolSummary, ConnectResult, MysqlPoolRegistry};
pub use schema_commands::{
    mysql_get_routine_signature, mysql_list_relations, mysql_list_schemas, mysql_list_structure,
    mysql_list_table_extras,
};
pub use schema_types::*;
pub use sql::{mysql_run_sql, mysql_run_sql_many};
pub use structure::{mysql_table_ddl, mysql_table_structure};
pub use tls::{apply_to_connect_options, map_ssl_mode, requires_tls};
pub use url::{parse_mysql_url, ParseResult};
