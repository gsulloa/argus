export type AppErrorKind =
  | "Storage"
  | "Keychain"
  | "NotFound"
  | "Validation"
  | "Internal"
  | "Postgres";

export interface PostgresErrorBody {
  code: string | null;
  message: string;
  /** 1-based character offset where Postgres reported the error, when known. */
  position?: number | null;
}

export class AppError extends Error {
  kind: AppErrorKind;
  /** Set when `kind === "Postgres"`. SQLSTATE if present, plus the server's message. */
  postgres?: PostgresErrorBody;

  constructor(kind: AppErrorKind, message: string, postgres?: PostgresErrorBody) {
    super(message);
    this.name = "AppError";
    this.kind = kind;
    this.postgres = postgres;
  }
}

const KNOWN_KINDS: AppErrorKind[] = [
  "Storage",
  "Keychain",
  "NotFound",
  "Validation",
  "Internal",
  "Postgres",
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

function isAppErrorPayload(
  v: unknown,
): v is { kind: AppErrorKind; message: string | PostgresErrorBody } {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.kind !== "string") return false;
  if (!KNOWN_KINDS.includes(o.kind as AppErrorKind)) return false;
  if (o.kind === "Postgres") {
    return isPostgresBody(o.message);
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
    return new AppError(e.kind, e.message as string);
  }
  if (typeof e === "string") return new AppError("Internal", e);
  if (e instanceof Error) return new AppError("Internal", e.message);
  return new AppError("Internal", "Unknown error");
}
