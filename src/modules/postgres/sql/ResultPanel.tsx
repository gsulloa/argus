import { useEffect, useMemo, useState } from "react";
import { AdhocResultGrid } from "../data/AdhocResultGrid";
import { Inspector as RowInspector } from "../data/Inspector";
import { useEditBuffer } from "../data/useEditBuffer";
import type { CellValue, DataColumn } from "../data/types";
import type { RunManyOutcome, RunSqlResult } from "./api";
import { MultiStatementTabs } from "./MultiStatementTabs";
import { ResultErrorBlock } from "./ResultErrorBlock";
import type { RunState } from "./useQueryRun";
import { sortResultRows, type SortOrder } from "@/platform/table/sortResultRows";
import styles from "./ResultPanel.module.css";

interface Props {
  state: RunState;
  /** Move the editor cursor to the absolute offset (used by error "Show in editor"). */
  onShowInEditor(offset: number): void;
}

export function ResultPanel({ state, onShowInEditor }: Props) {
  if (state.status === "idle") {
    return (
      <div className={styles.empty}>Press ⌘↩ to run · Tab to autocomplete</div>
    );
  }
  if (state.status === "running") {
    return <div className={styles.empty}>Running…</div>;
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
    return <ResultBody result={state.result} />;
  }
  // multi
  return (
    <MultiStatementTabs
      outcomes={state.outcomes}
      renderTab={(o) => renderMultiOutcome(o, state.statements, onShowInEditor)}
    />
  );
}

function renderMultiOutcome(
  outcome: RunManyOutcome,
  statements: { startOffset: number }[],
  onShowInEditor: (offset: number) => void,
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
  return <ResultBody result={outcome.result} />;
}

function ResultBody({ result }: { result: RunSqlResult }) {
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
  return <RowsResultView result={result} />;
}

function RowsResultView({
  result,
}: {
  result: Extract<RunSqlResult, { kind: "rows" }>;
}) {
  // Local row-selection state drives the inspector for this query result.
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  // Client-side sort state (issue #91). SQL results have no table context to
  // re-query, so sorting reorders the loaded rows in-memory.
  const [orderBy, setOrderBy] = useState<SortOrder[]>([]);
  // The shell inspector has stricter requirements (rowKey, buffer, etc.).
  // For ad-hoc results we render a slimmer side panel inline. Reuse the
  // existing RowInspector by passing an empty buffer; it already handles
  // the "no PK / no edits" branch as fully read-only.
  const dummyBuffer = useEditBuffer();

  // Reset the sort whenever the result's column shape changes (new query).
  const columnsSig = result.columns.map((c) => c.name).join("|");
  useEffect(() => {
    setOrderBy([]);
  }, [columnsSig]);

  // Sort the loaded rows client-side; the original result is never mutated.
  const sortedRows = useMemo(
    () =>
      sortResultRows(
        result.rows,
        result.columns.map((c) => c.name),
        orderBy,
        (row, i) => row[i],
      ),
    [result.rows, result.columns, orderBy],
  );

  return (
    <div className={styles.rowsLayout}>
      {result.truncated ? (
        <div className={styles.truncationBanner}>
          Result truncated at 10,000 rows — add a LIMIT clause to refine.
        </div>
      ) : null}
      <div className={styles.rowsBody}>
        <div className={styles.rowsGrid}>
          <AdhocResultGrid
            columns={result.columns}
            rows={sortedRows}
            selectedRowIndex={selectedRow}
            onSelectRow={setSelectedRow}
            orderBy={orderBy}
            onSortChange={setOrderBy}
            emptyState={<div className={styles.empty}>(0 rows)</div>}
          />
        </div>
        <div className={styles.rowsInspector}>
          <RowInspector
            columns={result.columns}
            selectedRows={
              selectedRow !== null && sortedRows[selectedRow]
                ? [
                    {
                      rowKey: "",
                      row: sortedRows[selectedRow]!,
                      pk: {},
                      source: "server" as const,
                      isDeleted: false,
                    },
                  ]
                : []
            }
            bulkEditAvailable={false}
            isReadOnly={true}
            pkColumns={null}
            enumValuesByColumn={{}}
            buffer={dummyBuffer}
          />
        </div>
      </div>
    </div>
  );
}

// Re-export for convenience.
export type { CellValue, DataColumn };
