export type AppErrorKind = "Storage" | "Keychain" | "NotFound" | "Validation" | "Internal";

export class AppError extends Error {
  kind: AppErrorKind;

  constructor(kind: AppErrorKind, message: string) {
    super(message);
    this.name = "AppError";
    this.kind = kind;
  }
}

function isAppErrorPayload(v: unknown): v is { kind: AppErrorKind; message: string } {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.kind === "string" &&
    ["Storage", "Keychain", "NotFound", "Validation", "Internal"].includes(o.kind) &&
    typeof o.message === "string"
  );
}

export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (isAppErrorPayload(e)) return new AppError(e.kind, e.message);
  if (typeof e === "string") return new AppError("Internal", e);
  if (e instanceof Error) return new AppError("Internal", e.message);
  return new AppError("Internal", "Unknown error");
}
