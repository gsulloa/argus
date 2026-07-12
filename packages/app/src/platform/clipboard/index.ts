/**
 * Shared clipboard write helper used across the app (grid and non-grid copy
 * sites). Writes plain text to the system clipboard and reports success so
 * callers can surface failures to the user (e.g. via the app toast) instead of
 * swallowing them silently.
 */

/** User-facing message shown when a clipboard write fails. */
export const COPY_FAILED_MESSAGE = "Copy failed";

/** User-facing message shown when a clipboard read fails. */
export const PASTE_FAILED_MESSAGE = "Paste failed";

/** User-facing message shown when a clipboard read succeeds but has no rows to paste. */
export const NOTHING_TO_PASTE_MESSAGE = "Nothing to paste";

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

/**
 * Read plain text from the system clipboard. Returns the text on success,
 * `null` on failure so callers can decide whether to surface the failure to
 * the user.
 */
export async function readClipboardText(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch (err) {
    console.warn("[clipboard] read failed:", err);
    return null;
  }
}
