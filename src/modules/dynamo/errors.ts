import type { AppError } from "@/platform/errors/AppError";

export type DynamoErrorCategory =
  | "session_expired" // access-keys session token expired
  | "sso_expired" // SSO session expired (separate UX: copy command, no re-prompt)
  | "access_denied" // IAM denied
  | "network" // DNS / endpoint / dispatch failure
  | "validation" // local validation
  | "other"; // anything else

/** Inspect an AppError and classify it for UI dispatch. */
export function classifyDynamoError(err: AppError): DynamoErrorCategory {
  if (err.kind === "Aws") {
    const body = err.aws!;
    const code = body.code;
    const msg = body.message?.toLowerCase() ?? "";

    if (code === "SsoExpired" || msg.includes("sso login --profile")) {
      return "sso_expired";
    }
    if (
      code === "ExpiredToken" ||
      code === "ExpiredTokenException" ||
      code === "InvalidClientTokenId" ||
      code === "RequestExpired"
    ) {
      return "session_expired";
    }
    if (code === "AccessDeniedException" || code === "AccessDenied") {
      return "access_denied";
    }
    if (code === "Timeout") {
      return "network";
    }
    if (code === "DispatchFailure" || code === "TimeoutError") {
      return "network";
    }
    return "other";
  }
  if (err.kind === "Validation") return "validation";
  return "other";
}

/** Extract the SSO login command suffix from an SSO-expired error message. */
export function extractSsoCommand(err: AppError): string | null {
  if (err.kind !== "Aws") return null;
  const msg = err.aws?.message ?? "";
  const m = msg.match(/aws sso login --profile (\S+)/);
  return m ? m[0] : null;
}
