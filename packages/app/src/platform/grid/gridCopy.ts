import { copyCellValue, copyRowsTsv, formatRowsTSV } from "./cellClipboard";

/**
 * Write plain text to the system clipboard. Returns `true` on success, `false`
 * on failure so callers can decide whether to surface the failure to the user.
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.warn("[gridCopy] clipboard write failed:", err);
    return false;
  }
}

/**
 * Minimal structural shape of the keyboard event the row-copy path needs. Kept
 * structural (not React.KeyboardEvent) so the helper is unit-testable without a
 * DOM event.
 */
export interface CopyKeyEvent {
  target: EventTarget | null;
  preventDefault: () => void;
}

export interface CopyRowRangeDeps {
  /** True when a cell editor is open — native text copy must apply instead. */
  editing: boolean;
  /** Non-null when a single cell is active — single-cell copy owns that path. */
  activeCell: unknown | null;
  /** Row-range selection anchor/active (both null = nothing selected). */
  selection: { anchor: number | null; active: number | null };
  /** Column names in display order. Reserved for future header-row support. */
  columnNames: string[];
  /** Resolve a row index to its ordered cell values, or null if the row is
   *  missing. Engine-specific (Postgres positional; MySQL/MSSQL via buffer). */
  resolveRow: (index: number) => unknown[] | null;
  /** Write the serialized TSV to the clipboard; resolves true on success. */
  write: (tsv: string) => Promise<boolean>;
  /** Called with a user-facing message when the clipboard write fails. */
  onError?: (message: string) => void;
}

const COPY_FAILED_MESSAGE = "Copy failed";

/**
 * Handle ⌘C / Ctrl+C row-range copy from the grid's keydown handler.
 *
 * Returns `true` when this path handled the event (a row range was copied),
 * `false` when it declined (edit mode, a native-editable target, a single cell
 * is active, or nothing is selected) so the caller can fall through.
 *
 * Row-range copy lives here (not on a window "copy" listener) because WebKit /
 * WKWebView does not dispatch a native `copy` event when the selection is a
 * CSS-only row highlight with no DOM text selection — see issue #213.
 */
export async function copyRowRangeFromKeydown(
  e: CopyKeyEvent,
  deps: CopyRowRangeDeps,
): Promise<boolean> {
  const { editing, activeCell, selection, resolveRow, write, onError } = deps;
  void deps.columnNames; // reserved for future header-row support

  if (editing) return false;

  const target = e.target as HTMLElement | null;
  if (target) {
    const tag = target.tagName?.toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
      return false;
    }
  }

  // Single-cell copy owns the active-cell path.
  if (activeCell !== null) return false;

  // Nothing selected — no-op (no error surfaced).
  if (selection.anchor === null || selection.active === null) return false;

  const from = Math.min(selection.anchor, selection.active);
  const to = Math.max(selection.anchor, selection.active);
  const resolved: unknown[][] = [];
  for (let i = from; i <= to; i++) {
    const cells = resolveRow(i);
    if (cells) resolved.push(cells);
  }
  if (resolved.length === 0) return false;

  e.preventDefault();
  const ok = await write(formatRowsTSV(resolved));
  if (!ok) onError?.(COPY_FAILED_MESSAGE);
  return true;
}

/**
 * Copy a single cell value to the clipboard.
 * Calls `onError` with a user-facing message on failure.
 * Returns `true` on success, `false` on failure.
 */
export async function copyCell(value: unknown, onError?: (message: string) => void): Promise<boolean> {
  const ok = await copyCellValue(value);
  if (!ok) onError?.(COPY_FAILED_MESSAGE);
  return ok;
}

/**
 * Copy multiple rows as TSV to the clipboard.
 * Calls `onError` with a user-facing message on failure.
 * Returns `true` on success, `false` on failure.
 */
export async function copyRows(rows: unknown[][], columnNames: string[], onError?: (message: string) => void): Promise<boolean> {
  const ok = await copyRowsTsv(rows, columnNames);
  if (!ok) onError?.(COPY_FAILED_MESSAGE);
  return ok;
}
