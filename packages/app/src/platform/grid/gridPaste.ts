import { NOTHING_TO_PASTE_MESSAGE, PASTE_FAILED_MESSAGE, readClipboardText } from "../clipboard";

// Re-exported so grid call sites can import both the read helper and the
// row-paste helper from "./gridPaste".
export { readClipboardText };

/**
 * Structural value type for a pasted cell. Kept local (rather than importing
 * an engine-specific `EditValue`) so this file stays engine-agnostic, mirroring
 * the `unknown`-based structural types in gridCopy.ts.
 */
export type PasteValue = string | number | boolean | null | object;

/**
 * Minimal structural shape of the keyboard event the row-paste path needs. Kept
 * structural (not React.KeyboardEvent) so the helper is unit-testable without a
 * DOM event.
 */
export interface PasteKeyEvent {
  target: EventTarget | null;
  preventDefault: () => void;
}

export interface PasteRowRangeDeps {
  /** True when a cell editor is open — native paste applies instead. */
  editing: boolean;
  /** Non-null when a single cell is active — single-cell paste owns that path. */
  activeCell: unknown | null;
  /** Row-range selection anchor/active (both null = nothing selected). */
  selection: { anchor: number | null; active: number | null };
  /** Columns in display order — used to map TSV cells positionally. */
  columns: { name: string }[];
  /** PK column names to omit from produced rows so DB defaults/fresh keys apply. */
  pkColumns: string[] | null;
  /** Read the clipboard text (inject `readClipboardText`). */
  read: () => Promise<string | null>;
  /** Called with the parsed row objects, one per pasted line. */
  onPasteRows: (rows: Record<string, PasteValue>[]) => void;
  /** Called with a user-facing message when the read fails or nothing was pasted. */
  onError?: (message: string) => void;
}

/**
 * Parse a TSV (tab-separated values) string into a 2-D array of raw string
 * cells. Inverse of `formatRowsTSV`.
 *
 * - Lines are split on `"\n"`; a single trailing `"\r"` is stripped from each
 *   line (so `\r\n` endings are handled).
 * - A single trailing empty line (produced by a trailing `"\n"`) is dropped.
 * - Each remaining line is split on `"\t"`.
 *
 * Pure — no DOM or clipboard access.
 */
export function parseTsvRows(text: string): string[][] {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.map((line) => line.split("\t"));
}

/**
 * Handle ⌘V / Ctrl+V row-range paste from the grid's keydown handler.
 *
 * Returns `true` when this path handled the event (rows were parsed from the
 * clipboard and `onPasteRows` was called, or an error was surfaced), `false`
 * when it declined (edit mode, a native-editable target, a single cell is
 * active, or nothing is selected) so the caller can fall through to native
 * paste handling.
 *
 * Row-range paste lives here (not on a window "paste" listener) because
 * WebKit / WKWebView does not dispatch a native `paste` event when the
 * selection is a CSS-only row highlight with no DOM text selection — see
 * issue #243 (mirrors the copy-side reasoning in issue #213).
 */
export async function pasteRowRangeFromKeydown(
  e: PasteKeyEvent,
  deps: PasteRowRangeDeps,
): Promise<boolean> {
  const { editing, activeCell, selection, columns, pkColumns, read, onPasteRows, onError } = deps;

  if (editing) return false;

  const target = e.target as HTMLElement | null;
  if (target) {
    const tag = target.tagName?.toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
      return false;
    }
  }

  // Single-cell paste owns the active-cell path.
  if (activeCell !== null) return false;

  // Nothing selected — no-op (no error surfaced).
  if (selection.anchor === null || selection.active === null) return false;

  e.preventDefault();

  const text = await read();
  if (text === null) {
    onError?.(PASTE_FAILED_MESSAGE);
    return true;
  }

  const parsed = parseTsvRows(text);
  if (parsed.length === 0) {
    onError?.(NOTHING_TO_PASTE_MESSAGE);
    return true;
  }

  const pkSet = pkColumns ? new Set(pkColumns) : null;
  const rows: Record<string, PasteValue>[] = parsed.map((line) => {
    const row: Record<string, PasteValue> = {};
    columns.forEach((column, i) => {
      if (pkSet?.has(column.name)) return;
      if (i >= line.length) return;
      const cell = line[i]!;
      row[column.name] = cell === "" ? null : cell;
    });
    return row;
  });

  onPasteRows(rows);
  return true;
}
