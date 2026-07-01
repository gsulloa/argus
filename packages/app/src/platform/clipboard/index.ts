/**
 * Shared clipboard write helper used across the app (grid and non-grid copy
 * sites). Writes plain text to the system clipboard and reports success so
 * callers can surface failures to the user (e.g. via the app toast) instead of
 * swallowing them silently.
 */

/** User-facing message shown when a clipboard write fails. */
export const COPY_FAILED_MESSAGE = "Copy failed";

/**
 * Write plain text to the system clipboard. Returns `true` on success, `false`
 * on failure so callers can decide whether to surface the failure to the user.
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.warn("[clipboard] write failed:", err);
    return false;
  }
}
