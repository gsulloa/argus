import { AppError } from "@/platform/errors/AppError";

/** SQLSTATE for `query_canceled` — what the backend returns on its own 15s timeout. */
export const RETRYABLE_TIMEOUT_CODE = "57014";

export function isPostgresTimeout(err: AppError): boolean {
  return err.kind === "Postgres" && err.postgres?.code === RETRYABLE_TIMEOUT_CODE;
}
