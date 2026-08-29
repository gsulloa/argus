import { useEffect, useMemo, useState } from "react";
import { AdhocResultGrid, type AdhocGridEdit } from "../data/AdhocResultGrid";
import { Inspector as RowInspector } from "../data/Inspector";
import { useEditBuffer, type UseEditBufferResult } from "../data/useEditBuffer";
import {
  blockReasonCopy,
  isEditableResult,
  type CellValue,
  type DataColumn,
  type EditValue,
  type ResultEditability,
} from "../data/types";
import type { RunManyOutcome, RunSqlResult } from "./api";
import { MultiStatementTabs } from "./MultiStatementTabs";
import { ResultErrorBlock } from "./ResultErrorBlock";
import type { RunState } from "./useQueryRun";
import { sortResultRows, type SortOrder } from "@/platform/table/sortResultRows";
import { TruncationBanner, type RowCapSource } from "@/platform/sql/TruncationBanner";
import styles from "./ResultPanel.module.css";

/**
 * Everything the panel needs to decide whether a rows result is editable, and
 * to report a dirty buffer back to the tab (which owns Save/Discard and the
 * loss guards). Absent → the panel behaves as the read-only panel always has,
 * which is what every non-Postgres-editor consumer and every test wants.
 */
export interface ResultEditContext {
  /** Buffer shared with the tab so it can Save/Discard and guard tab close. */
  buffer: UseEditBufferResult;
  /** False when the connection is `read_only`. */
  connectionWritable: boolean;
}

interface Props {
  state: RunState;
  /** Move the editor cursor to the absolute offset (used by error "Show in editor"). */
  onShowInEditor(offset: number): void;
  /** Opt into inline result editing. Omitted → fully read-only panel. */
  edit?: ResultEditContext;
  /** Op-level failure from the last save, rendered above the grid. */
  saveError?: string | null;
  /** Dismiss the save-error banner. */
  onDismissSaveError?(): void;
}

/**
 * Hover copy for a cell the user can't edit. Precedence matters: a read-only
 * connection is the user's most actionable fact, so it wins over whatever the
 * backend said about the projection; a run still in flight comes next, since
 * it's transient.
 */
function resolveBlockedReason(args: {
  editability: ResultEditability | undefined;
  connectionWritable: boolean;
  isMulti: boolean;
  isStreaming: boolean;
}): string {
  const { editability, connectionWritable, isMulti, isStreaming } = args;
  if (!connectionWritable) return "Read-only connection — edits disabled";
  if (isMulti) return "Not editable — results from a multi-statement run are read-only";
  if (isStreaming) return "Not editable while the query is still loading";
  if (!editability) return "Not editable — this result isn't a plain table projection";
  if (editability.status === "editable") return "";
  return blockReasonCopy(editability.reason);
}

export function ResultPanel({
  state,
  onShowInEditor,
  edit,
  saveError,
  onDismissSaveError,
}: Props) {
  if (state.status === "idle") {
    return (
      <div className={styles.empty}>Press ⌘↩ to run · Tab to autocomplete</div>
    );
  }
  if (state.status === "running") {
    return <div className={styles.empty}>Running…</div>;
  }
  if (state.status === "cancelled") {
    return <div className={styles.empty}>Query cancelled</div>;
  }
  // streaming — grid shows immediately with accumulated rows and a loading banner
  if (state.status === "streaming") {
    return (
      <RowsResultView
        columns={state.columns}
        rows={state.rows}
        truncated={false}
        truncated_columns={[]}
        loading={{ count: state.loadedCount }}
        editability={state.editability}
        edit={edit}
        isMulti={false}
        saveError={saveError}
        onDismissSaveError={onDismissSaveError}
      />
    );
  }
  // done
  if (state.mode === "single") {
    if (state.error) {
      return (
        <div className={styles.body}>
          <ResultErrorBlock
            message={state.error.message}
            code={state.error.code}
            position={state.error.position}
            statementStartOffset={state.startOffset}
            onShowInEditor={onShowInEditor}
          />
        </div>
      );
    }
    if (!state.result) return null;
    return (
      <ResultBody
        result={state.result}
        edit={edit}
        isMulti={false}
        saveError={saveError}
        onDismissSaveError={onDismissSaveError}
      />
    );
  }
  // multi
  return (
    <MultiStatementTabs
      outcomes={state.outcomes}
      renderTab={(o) => renderMultiOutcome(o, state.statements, onShowInEditor, edit)}
    />
  );
}

function renderMultiOutcome(
  outcome: RunManyOutcome,
  statements: { startOffset: number }[],
  onShowInEditor: (offset: number) => void,
  edit: ResultEditContext | undefined,
) {
  if (outcome.status === "skipped") {
    return <div className={styles.empty}>Skipped — a previous statement failed.</div>;
  }
  if (outcome.status === "err") {
    const stmt = statements[outcome.statement_index];
    return (
      <div className={styles.body}>
        <ResultErrorBlock
          message={outcome.error.message}
          code={outcome.error.code}
          position={outcome.error.position}
          statementIndex={outcome.statement_index}
          statementStartOffset={stmt?.startOffset ?? 0}
          onShowInEditor={onShowInEditor}
        />
      </div>
    );
  }
  // Multi-statement results stay read-only: a post-save re-run would re-fire
  // every statement in the batch, including any DML among them.
  return <ResultBody result={outcome.result} edit={edit} isMulti />;
}

function ResultBody({
  result,
  edit,
  isMulti,
  saveError,
  onDismissSaveError,
}: {
  result: RunSqlResult;
  edit?: ResultEditContext;
  isMulti: boolean;
  saveError?: string | null;
  onDismissSaveError?(): void;
}) {
  if (result.kind === "affected") {
    return (
      <div className={styles.summary}>
        <span className={styles.summaryTag}>{result.command_tag}</span>
        <span className={styles.summaryText}>
          {result.affected_rows} rows affected · {result.query_ms} ms
        </span>
      </div>
    );
  }
  return (
    <RowsResultView
      columns={result.columns}
      rows={result.rows}
      truncated={result.truncated}
      truncated_columns={result.truncated_columns}
      rowCap={result.row_cap}
      rowCapSource={result.row_cap_source}
      editability={result.editability}
      edit={edit}
      isMulti={isMulti}
      saveError={saveError}
      onDismissSaveError={onDismissSaveError}
    />
  );
}

interface RowsResultViewProps {
  columns: DataColumn[];
  rows: CellValue[][];
  truncated: boolean;
  truncated_columns: string[];
  /** Required when `truncated` may be true — omitted for the streaming-in-flight case. */
  rowCap?: number;
  rowCapSource?: RowCapSource;
  /** When set, the grid is still growing (streaming in flight). */
  loading?: { count: number };
  editability?: ResultEditability;
  edit?: ResultEditContext;
  isMulti: boolean;
  saveError?: string | null;
  onDismissSaveError?(): void;
}

function RowsResultView({
  columns,
  rows,
  truncated,
  rowCap,
  rowCapSource,
  loading,
  editability,
  edit,
  isMulti,
  saveError,
  onDismissSaveError,
}: RowsResultViewProps) {
  // Row-range selection state drives the inspector for this query result.
  const [selection, setSelection] = useState<{ anchor: number | null; active: number | null }>({
    anchor: null,
    active: null,
  });
  // Client-side sort state (issue #91). SQL results have no table context to
  // re-query, so sorting reorders the loaded rows in-memory.
  const [orderBy, setOrderBy] = useState<SortOrder[]>([]);
  // The shell inspector has stricter requirements (rowKey, buffer, etc.).
  // For ad-hoc results we render a slimmer side panel inline. The inspector is
  // read-only in every case (editing happens in the grid), so it gets a
  // throwaway buffer rather than the real one — it already handles the
  // "no PK / no edits" branch as fully read-only.
  const inspectorBuffer = useEditBuffer();

  // Reset the sort (and selection) whenever the result's column shape changes (new query).
  // Only reset when NOT loading (streaming) to avoid resetting on each batch.
  const columnsSig = columns.map((c) => c.name).join("|");
  const clearBuffer = edit?.buffer.clear;
  useEffect(() => {
    if (!loading) {
      setOrderBy([]);
      setSelection({ anchor: null, active: null });
      // A new column shape means a new query — any pending edits referenced
      // rows that are no longer on screen, so carrying them forward would let
      // a save write values the user can no longer see.
      clearBuffer?.();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnsSig]);

  // -----------------------------------------------------------------------
  // Edit configuration
  // -----------------------------------------------------------------------
  const blockedReason = resolveBlockedReason({
    editability,
    connectionWritable: edit?.connectionWritable ?? false,
    isMulti,
    isStreaming: !!loading,
  });

  // The grid always receives an `edit` config when the panel has a buffer, even
  // for a blocked result — that is how a non-editable cell gets its hover
  // explanation instead of silently swallowing the double-click.
  const gridEdit: AdhocGridEdit | undefined = useMemo(() => {
    if (!edit) return undefined;
    const editable = isEditableResult(editability) ? editability : null;
    return {
      buffer: edit.buffer,
      columnSources: editable?.column_sources ?? columns.map(() => null),
      pkColumns: editable?.pk_columns ?? [],
      pkColumnIndexes: editable?.pk_column_indexes ?? [],
      enumValuesByColumn: editable?.enums ?? {},
      blockedReason,
    };
  }, [edit, editability, columns, blockedReason]);

  // Sort the loaded rows client-side; the original result is never mutated.
  // During streaming, sort is disabled — pass rows as-is.
  const sortedRows = useMemo(
    () =>
      loading
        ? rows
        : sortResultRows(
            rows,
            columns.map((c) => c.name),
            orderBy,
            (row, i) => row[i],
          ),
    [rows, columns, orderBy, loading],
  );

  // Compute selected rows from anchor/active range to pass to inspector.
  const inspectorRows = useMemo(() => {
    if (selection.anchor === null || selection.active === null) return [];
    const from = Math.min(selection.anchor, selection.active);
    const to = Math.max(selection.anchor, selection.active);
    const result: Array<{
      rowKey: string;
      row: CellValue[];
      pk: Record<string, EditValue>;
      source: "server";
      isDeleted: boolean;
    }> = [];
    for (let i = from; i <= to; i++) {
      const row = sortedRows[i];
      if (row) {
        result.push({ rowKey: "", row, pk: {}, source: "server" as const, isDeleted: false });
      }
    }
    return result;
  }, [selection, sortedRows]);

  return (
    <div className={styles.rowsLayout}>
      {loading ? (
        <div className={styles.loadingBanner}>
          Loading… {loading.count.toLocaleString()} rows
        </div>
      ) : null}
      {truncated && rowCap !== undefined && rowCapSource ? (
        <TruncationBanner rowCap={rowCap} rowCapSource={rowCapSource} clause="LIMIT" />
      ) : null}
      {saveError ? (
        <div className={styles.saveErrorBanner} role="alert">
          <span>{saveError}</span>
          <button
            type="button"
            className={styles.saveErrorDismiss}
            onClick={onDismissSaveError}
            aria-label="Dismiss save error"
          >
            ×
          </button>
        </div>
      ) : null}
      <div className={styles.rowsBody}>
        <div className={styles.rowsGrid}>
          <AdhocResultGrid
            columns={columns}
            rows={sortedRows}
            edit={gridEdit}
            onSelectionChange={setSelection}
            orderBy={loading ? [] : orderBy}
            onSortChange={loading ? () => {} : setOrderBy}
            emptyState={<div className={styles.empty}>(0 rows)</div>}
          />
        </div>
        <div className={styles.rowsInspector}>
          <RowInspector
            columns={columns}
            selectedRows={inspectorRows}
            bulkEditAvailable={false}
            isReadOnly={true}
            pkColumns={null}
            enumValuesByColumn={{}}
            buffer={inspectorBuffer}
          />
        </div>
      </div>
    </div>
  );
}

// Re-export for convenience.
export type { CellValue, DataColumn };
