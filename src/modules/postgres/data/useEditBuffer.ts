import { useCallback, useMemo, useReducer } from "react";
import type { CellValue, EditOp, EditValue, RefreshedRow } from "./types";

/**
 * Stable string representation of a row's primary key. Used as the buffer's
 * key. For inserted rows that don't have a PK yet, we use `tmp:<uuid>`.
 *
 * Existing-row keys are deterministic: we sort PK column names
 * alphabetically and serialize each value via JSON.stringify so two
 * different orderings of the same PK collapse to the same key.
 */
export type RowKey = string;

export function buildRowKey(pk: Record<string, EditValue>): RowKey {
  const keys = Object.keys(pk).sort();
  const obj: Record<string, EditValue> = {};
  for (const k of keys) {
    const v = pk[k];
    obj[k] = v === undefined ? null : v;
  }
  return JSON.stringify(obj);
}

let tmpCounter = 0;
function nextTmpKey(): RowKey {
  tmpCounter += 1;
  return `tmp:${tmpCounter}-${Math.random().toString(36).slice(2, 10)}`;
}

export type RowEditKind = "update" | "insert" | "delete";

export interface RowEdits {
  kind: RowEditKind;
  /** For `update`: PK columns of the existing row (immutable in this buffer entry). */
  pk: Record<string, EditValue>;
  /** Edited columns. For `insert`: every column the user typed into. */
  changes: Record<string, EditValue>;
  /**
   * Snapshot of the row's server values at the time the first edit was made.
   * Used to revert via undo and to compute the diff. `null` for inserts.
   */
  originalRow: CellValue[] | null;
  /** Column names corresponding to `originalRow`, in the same order. */
  originalColumns: string[] | null;
}

interface BufferState {
  /** Map from RowKey → RowEdits. */
  rows: Map<RowKey, RowEdits>;
  /** LIFO stack of inverse actions for `undo`. Cleared on `clear` / `commitSuccess`. */
  undoStack: UndoEntry[];
}

type UndoEntry =
  | {
      kind: "set-cell-prev";
      rowKey: RowKey;
      column: string;
      hadEdit: boolean;
      previous?: EditValue;
      // If the row didn't exist in the buffer before, removing the cell
      // restores it to "clean".
      removeRowIfEmpty: boolean;
    }
  | { kind: "remove-row"; rowKey: RowKey; entry: RowEdits }
  | { kind: "restore-row"; rowKey: RowKey; entry: RowEdits };

type Action =
  | {
      type: "set-cell";
      rowKey: RowKey;
      column: string;
      value: EditValue;
      pk: Record<string, EditValue>;
      originalRow: CellValue[] | null;
      originalColumns: string[] | null;
    }
  | { type: "mark-delete"; rowKey: RowKey; pk: Record<string, EditValue> }
  | { type: "unmark-delete"; rowKey: RowKey }
  | {
      type: "add-insert";
      rowKey: RowKey;
      values: Record<string, EditValue>;
    }
  | { type: "remove-insert"; rowKey: RowKey }
  | { type: "undo" }
  | { type: "clear" }
  | { type: "commit-success" };

function initialState(): BufferState {
  return { rows: new Map(), undoStack: [] };
}

function reducer(state: BufferState, action: Action): BufferState {
  switch (action.type) {
    case "set-cell": {
      const { rowKey, column, value, pk, originalRow, originalColumns } = action;
      const next = new Map(state.rows);
      const cur = next.get(rowKey);
      const previousChanges = cur?.changes ?? {};
      const hadEdit = column in previousChanges;
      const previous = previousChanges[column];

      const merged: RowEdits = {
        // If the row was already marked delete, switching to update is the
        // wrong move; we keep `delete` and silently drop the cell edit.
        kind: cur?.kind === "delete" ? "delete" : cur?.kind ?? "update",
        pk: cur?.pk ?? pk,
        changes: { ...previousChanges, [column]: value },
        originalRow: cur?.originalRow ?? originalRow,
        originalColumns: cur?.originalColumns ?? originalColumns,
      };
      // Drop the cell edit if it equals the original — keeps the buffer clean.
      if (
        merged.kind !== "insert" &&
        originalRow !== null &&
        originalColumns !== null
      ) {
        const idx = originalColumns.indexOf(column);
        if (idx >= 0 && cellEquals(originalRow[idx] ?? null, value)) {
          delete merged.changes[column];
        }
      }
      // If the entry is still a "delete", do not stash a cell edit.
      if (cur?.kind === "delete") {
        return state;
      }
      // If after the edit the changes object is empty AND this is an
      // existing-row update, remove the row from the buffer entirely.
      const isEmptyUpdate = merged.kind === "update" && Object.keys(merged.changes).length === 0;
      let undo: UndoEntry;
      if (isEmptyUpdate) {
        next.delete(rowKey);
        undo = cur
          ? { kind: "restore-row", rowKey, entry: cur }
          : { kind: "set-cell-prev", rowKey, column, hadEdit, previous, removeRowIfEmpty: true };
      } else {
        next.set(rowKey, merged);
        undo = {
          kind: "set-cell-prev",
          rowKey,
          column,
          hadEdit,
          previous,
          removeRowIfEmpty: !cur,
        };
      }
      return { rows: next, undoStack: [...state.undoStack, undo] };
    }
    case "mark-delete": {
      const next = new Map(state.rows);
      const cur = next.get(action.rowKey);
      // Marking an insert row as "delete" instead removes it from the buffer.
      if (cur?.kind === "insert") {
        next.delete(action.rowKey);
        return {
          rows: next,
          undoStack: [
            ...state.undoStack,
            { kind: "restore-row", rowKey: action.rowKey, entry: cur },
          ],
        };
      }
      // Already marked as delete — no-op.
      if (cur?.kind === "delete") return state;
      const undo: UndoEntry = cur
        ? { kind: "restore-row", rowKey: action.rowKey, entry: cur }
        : { kind: "remove-row", rowKey: action.rowKey, entry: { kind: "delete", pk: action.pk, changes: {}, originalRow: null, originalColumns: null } };
      const merged: RowEdits = {
        kind: "delete",
        pk: action.pk,
        changes: {},
        originalRow: cur?.originalRow ?? null,
        originalColumns: cur?.originalColumns ?? null,
      };
      next.set(action.rowKey, merged);
      return { rows: next, undoStack: [...state.undoStack, undo] };
    }
    case "unmark-delete": {
      const next = new Map(state.rows);
      const cur = next.get(action.rowKey);
      if (!cur || cur.kind !== "delete") return state;
      next.delete(action.rowKey);
      return {
        rows: next,
        undoStack: [
          ...state.undoStack,
          { kind: "restore-row", rowKey: action.rowKey, entry: cur },
        ],
      };
    }
    case "add-insert": {
      const next = new Map(state.rows);
      const entry: RowEdits = {
        kind: "insert",
        pk: {},
        changes: action.values,
        originalRow: null,
        originalColumns: null,
      };
      next.set(action.rowKey, entry);
      return {
        rows: next,
        undoStack: [
          ...state.undoStack,
          { kind: "remove-row", rowKey: action.rowKey, entry },
        ],
      };
    }
    case "remove-insert": {
      const next = new Map(state.rows);
      const cur = next.get(action.rowKey);
      if (!cur || cur.kind !== "insert") return state;
      next.delete(action.rowKey);
      return {
        rows: next,
        undoStack: [
          ...state.undoStack,
          { kind: "restore-row", rowKey: action.rowKey, entry: cur },
        ],
      };
    }
    case "undo": {
      if (state.undoStack.length === 0) return state;
      const last = state.undoStack[state.undoStack.length - 1];
      if (!last) return state;
      const undoStack = state.undoStack.slice(0, -1);
      const next = new Map(state.rows);
      if (last.kind === "set-cell-prev") {
        const cur = next.get(last.rowKey);
        if (!cur) {
          return { rows: next, undoStack };
        }
        const changes = { ...cur.changes };
        if (last.hadEdit) {
          changes[last.column] = last.previous as EditValue;
        } else {
          delete changes[last.column];
        }
        if (
          last.removeRowIfEmpty &&
          Object.keys(changes).length === 0 &&
          cur.kind === "update"
        ) {
          next.delete(last.rowKey);
        } else {
          next.set(last.rowKey, { ...cur, changes });
        }
        return { rows: next, undoStack };
      }
      if (last.kind === "remove-row") {
        next.delete(last.rowKey);
        return { rows: next, undoStack };
      }
      // restore-row
      next.set(last.rowKey, last.entry);
      return { rows: next, undoStack };
    }
    case "clear":
      return initialState();
    case "commit-success":
      return initialState();
    default:
      return state;
  }
}

function cellEquals(a: CellValue, b: EditValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) {
    // number/string mismatches handled by JSON-stringify equality below.
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------
// Public hook API
// --------------------------------------------------------------------------

export interface UseEditBufferResult {
  rows: Map<RowKey, RowEdits>;
  hasDirty: boolean;
  dirtyCounts: { updates: number; inserts: number; deletes: number };
  /** Returns the buffer entry for the given row, or undefined when clean. */
  getRowEdits(rowKey: RowKey): RowEdits | undefined;
  /**
   * Buffer-aware value lookup. Returns the dirty value if the cell is in the
   * buffer's update/insert set; otherwise the server value.
   */
  getDisplayValue(
    rowKey: RowKey,
    serverRow: CellValue[],
    columns: string[],
    columnName: string,
  ): CellValue | EditValue;
  /** True when the cell has a pending edit in the buffer. */
  isCellDirty(rowKey: RowKey, column: string): boolean;
  /** True when the row is marked for delete. */
  isRowDeleted(rowKey: RowKey): boolean;
  setCellEdit(args: {
    rowKey: RowKey;
    column: string;
    value: EditValue;
    pk: Record<string, EditValue>;
    originalRow: CellValue[] | null;
    originalColumns: string[] | null;
  }): void;
  markRowDelete(rowKey: RowKey, pk: Record<string, EditValue>): void;
  markRowUndelete(rowKey: RowKey): void;
  addInsertRow(values?: Record<string, EditValue>): RowKey;
  removeInsertRow(rowKey: RowKey): void;
  undo(): void;
  clear(): void;
  commitSuccess(): void;
  /** Build the list of `EditOp`s to send to the backend. Order: updates, inserts, deletes. */
  toEditOps(): EditOp[];
  /** Build a parallel list of RowKeys aligned with `toEditOps()`. */
  toRowKeys(): RowKey[];
}

export function useEditBuffer(): UseEditBufferResult {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  const dirtyCounts = useMemo(() => {
    let updates = 0;
    let inserts = 0;
    let deletes = 0;
    for (const e of state.rows.values()) {
      if (e.kind === "update") updates += 1;
      else if (e.kind === "insert") inserts += 1;
      else deletes += 1;
    }
    return { updates, inserts, deletes };
  }, [state.rows]);

  const hasDirty = state.rows.size > 0;

  const getRowEdits = useCallback(
    (rowKey: RowKey) => state.rows.get(rowKey),
    [state.rows],
  );

  const getDisplayValue = useCallback(
    (rowKey: RowKey, serverRow: CellValue[], columns: string[], columnName: string) => {
      const e = state.rows.get(rowKey);
      if (e && columnName in e.changes) {
        return e.changes[columnName] as EditValue;
      }
      const idx = columns.indexOf(columnName);
      return idx >= 0 ? (serverRow[idx] ?? null) : null;
    },
    [state.rows],
  );

  const isCellDirty = useCallback(
    (rowKey: RowKey, column: string) => {
      const e = state.rows.get(rowKey);
      return !!e && (e.kind === "update" || e.kind === "insert") && column in e.changes;
    },
    [state.rows],
  );

  const isRowDeleted = useCallback(
    (rowKey: RowKey) => state.rows.get(rowKey)?.kind === "delete",
    [state.rows],
  );

  const setCellEdit = useCallback(
    (args: {
      rowKey: RowKey;
      column: string;
      value: EditValue;
      pk: Record<string, EditValue>;
      originalRow: CellValue[] | null;
      originalColumns: string[] | null;
    }) => {
      dispatch({ type: "set-cell", ...args });
    },
    [],
  );

  const markRowDelete = useCallback(
    (rowKey: RowKey, pk: Record<string, EditValue>) => {
      dispatch({ type: "mark-delete", rowKey, pk });
    },
    [],
  );

  const markRowUndelete = useCallback((rowKey: RowKey) => {
    dispatch({ type: "unmark-delete", rowKey });
  }, []);

  const addInsertRow = useCallback((values?: Record<string, EditValue>) => {
    const rowKey = nextTmpKey();
    dispatch({ type: "add-insert", rowKey, values: values ?? {} });
    return rowKey;
  }, []);

  const removeInsertRow = useCallback((rowKey: RowKey) => {
    dispatch({ type: "remove-insert", rowKey });
  }, []);

  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const clear = useCallback(() => dispatch({ type: "clear" }), []);
  const commitSuccess = useCallback(() => dispatch({ type: "commit-success" }), []);

  const toEditOps = useCallback((): EditOp[] => {
    const updates: EditOp[] = [];
    const inserts: EditOp[] = [];
    const deletes: EditOp[] = [];
    for (const e of state.rows.values()) {
      if (e.kind === "update") {
        updates.push({ kind: "update", pk: e.pk, changes: e.changes });
      } else if (e.kind === "insert") {
        inserts.push({ kind: "insert", values: e.changes });
      } else {
        deletes.push({ kind: "delete", pk: e.pk });
      }
    }
    return [...updates, ...inserts, ...deletes];
  }, [state.rows]);

  const toRowKeys = useCallback((): RowKey[] => {
    const updates: RowKey[] = [];
    const inserts: RowKey[] = [];
    const deletes: RowKey[] = [];
    for (const [k, e] of state.rows) {
      if (e.kind === "update") updates.push(k);
      else if (e.kind === "insert") inserts.push(k);
      else deletes.push(k);
    }
    return [...updates, ...inserts, ...deletes];
  }, [state.rows]);

  return {
    rows: state.rows,
    hasDirty,
    dirtyCounts,
    getRowEdits,
    getDisplayValue,
    isCellDirty,
    isRowDeleted,
    setCellEdit,
    markRowDelete,
    markRowUndelete,
    addInsertRow,
    removeInsertRow,
    undo,
    clear,
    commitSuccess,
    toEditOps,
    toRowKeys,
  };
}

/** Build a refreshed-row reconciliation map from the apply response. */
export function buildRefreshedRowMap(refreshed: RefreshedRow[]): Map<RowKey, RefreshedRow> {
  const m = new Map<RowKey, RefreshedRow>();
  for (const r of refreshed) {
    m.set(buildRowKey(r.pk), r);
  }
  return m;
}
