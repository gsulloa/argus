import { postgresApi } from "./api";
import type { ParseUrlResult } from "./types";

/**
 * Parse a `postgresql://` URL by delegating to the Rust implementation,
 * keeping behavior identical between CLI URL paste and any future server-side
 * use. Returns the typed `AppError::Validation` on failure.
 */
export function parsePostgresUrl(input: string): Promise<ParseUrlResult> {
  return postgresApi.parseUrl(input);
}
