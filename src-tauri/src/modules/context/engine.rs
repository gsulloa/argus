/// The data-source engine associated with a connection.
///
/// Used to determine which subtree of a context folder to read and which
/// query file extensions are valid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EngineKind {
    Postgres,
    Mysql,
    Mssql,
    Dynamo,
    Cloudwatch,
}

impl EngineKind {
    /// Map the `kind` string stored on a `Connection` to an `EngineKind`.
    pub fn from_connection_kind(kind: &str) -> Option<Self> {
        match kind {
            "postgres" => Some(Self::Postgres),
            "mysql" => Some(Self::Mysql),
            "mssql" => Some(Self::Mssql),
            "dynamo" => Some(Self::Dynamo),
            "cloudwatch" => Some(Self::Cloudwatch),
            _ => None,
        }
    }

    /// The subdirectory name under the context folder root for this engine.
    pub fn subtree(&self) -> &'static str {
        match self {
            Self::Postgres => "postgres",
            Self::Mysql => "mysql",
            Self::Mssql => "mssql",
            Self::Dynamo => "dynamo",
            Self::Cloudwatch => "cloudwatch",
        }
    }

    /// Recognised body-file extensions inside this engine's `queries/` directory.
    pub fn query_extensions(&self) -> &'static [&'static str] {
        match self {
            Self::Postgres | Self::Mysql | Self::Mssql => &["sql"],
            Self::Dynamo => &["partiql"],
            Self::Cloudwatch => &["cwlogs"],
        }
    }
}
