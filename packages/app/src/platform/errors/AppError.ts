export type AppErrorKind =
  | "Storage"
  | "Keychain"
  | "NotFound"
  | "Validation"
  | "Internal"
  | "Postgres"
  | "Aws"
  | "Mysql"
  | "Mssql";

export interface PostgresErrorBody {
  code: string | null;
  message: string;
  /** 1-based character offset where Postgres reported the error, when known. */
  position?: number | null;
}

export interface AwsErrorBody {
  code: string;
  message: string;
  retryable: boolean;
}

export interface MysqlErrorBody {
  code: string | null;
  message: string;
  /** 1-based character offset where MySQL reported the error, when known. */
  position?: number | null;
}

export interface MssqlErrorBody {
  /** Numeric SQL Server error code (e.g. 18456 for auth failure). `null` for driver-level errors. */
  code: number | null;
  message: string;
  /** 1-based line number inside the SQL batch where the error occurred. */
  line?: number | null;
  /** Stored procedure or trigger name, if applicable. */
  procedure?: string | null;
}

export class AppError extends Error {
  kind: AppErrorKind;
  /** Set when `kind === "Postgres"`. SQLSTATE if present, plus the server's message. */
  postgres?: PostgresErrorBody;
  /** Set when `kind === "Aws"`. AWS error code, message, and retryability flag. */
  aws?: AwsErrorBody;
  /** Set when `kind === "Mysql"`. SQLSTATE if present, plus the server's message. */
  mysql?: MysqlErrorBody;
  /** Set when `kind === "Mssql"`. Numeric SQL Server error code, message, line, procedure. */
  mssql?: MssqlErrorBody;

  constructor(
    kind: AppErrorKind,
    message: string,
    postgres?: PostgresErrorBody,
    aws?: AwsErrorBody,
    mysql?: MysqlErrorBody,
    mssql?: MssqlErrorBody,
  ) {
    super(message);
    this.name = "AppError";
    this.kind = kind;
    this.postgres = postgres;
    this.aws = aws;
    this.mysql = mysql;
    this.mssql = mssql;
  }
}

const KNOWN_KINDS: AppErrorKind[] = [
  "Storage",
  "Keychain",
  "NotFound",
  "Validation",
  "Internal",
  "Postgres",
  "Aws",
  "Mysql",
  "Mssql",
];

function isPostgresBody(v: unknown): v is PostgresErrorBody {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    (o.code === null || typeof o.code === "string") &&
    typeof o.message === "string" &&
    (o.position === undefined ||
      o.position === null ||
      typeof o.position === "number")
  );
}

function isAwsBody(v: unknown): v is AwsErrorBody {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.code === "string" &&
    typeof o.message === "string" &&
    typeof o.retryable === "boolean"
  );
}

function isMysqlBody(v: unknown): v is MysqlErrorBody {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    (o.code === null || typeof o.code === "string") &&
    typeof o.message === "string" &&
    (o.position === undefined ||
      o.position === null ||
      typeof o.position === "number")
  );
}

function isMssqlBody(v: unknown): v is MssqlErrorBody {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    (o.code === null || typeof o.code === "number") &&
    typeof o.message === "string"
  );
}

function isAppErrorPayload(
  v: unknown,
): v is { kind: AppErrorKind; message: string | PostgresErrorBody | AwsErrorBody | MysqlErrorBody | MssqlErrorBody } {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.kind !== "string") return false;
  if (!KNOWN_KINDS.includes(o.kind as AppErrorKind)) return false;
  if (o.kind === "Postgres") {
    return isPostgresBody(o.message);
  }
  if (o.kind === "Aws") {
    return isAwsBody(o.message);
  }
  if (o.kind === "Mysql") {
    return isMysqlBody(o.message);
  }
  if (o.kind === "Mssql") {
    return isMssqlBody(o.message);
  }
  return typeof o.message === "string";
}

export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (isAppErrorPayload(e)) {
    if (e.kind === "Postgres" && isPostgresBody(e.message)) {
      const body = e.message;
      return new AppError("Postgres", body.message, body);
    }
    if (e.kind === "Aws" && isAwsBody(e.message)) {
      const body = e.message;
      return new AppError("Aws", body.message, undefined, body);
    }
    if (e.kind === "Mysql" && isMysqlBody(e.message)) {
      const body = e.message;
      return new AppError("Mysql", body.message, undefined, undefined, body);
    }
    if (e.kind === "Mssql" && isMssqlBody(e.message)) {
      const body = e.message;
      return new AppError("Mssql", body.message, undefined, undefined, undefined, body);
    }
    return new AppError(e.kind, e.message as string);
  }
  if (typeof e === "string") return new AppError("Internal", e);
  if (e instanceof Error) return new AppError("Internal", e.message);
  return new AppError("Internal", "Unknown error");
}
