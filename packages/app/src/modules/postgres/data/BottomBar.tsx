import { Loader2, Plus } from "lucide-react";
import styles from "./BottomBar.module.css";

interface Props {
  rowsLoaded: number;
  highestLoadedPage: number;
  pageSize: number;
  pageSizeOptions: number[];
  totalRows: number | null;
  countLoading: boolean;
  countError: string | null;
  queryMs: number | null;
  filterCount: number;
  reachedEnd: boolean;
  /** When `true` (writable connection on a table), the Save control is rendered. */
  editable: boolean;
  /** When `true`, the "Add row" button is rendered. */
  canInsert: boolean;
  /** When `true`, the read-only banner replaces the edit controls. */
  readOnlyBanner: boolean;
  /** When `true`, the no-PK banner is shown alongside the Add-row button. */
  noPkBanner: boolean;
  /** Sum of dirty entries (updates + inserts + deletes) — drives the Save badge. */
  dirtyCount: number;
  /** Number of currently-selected rows. Chip renders when >= 2. */
  selectedCount: number;
  onPageSizeChange(next: number): void;
  onCountRows(): void;
  onClearFilters(): void;
  onAddRow(): void;
  onSave(): void;
  onClearSelection(): void;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

export function BottomBar(props: Props) {
  const {
    rowsLoaded,
    highestLoadedPage,
    pageSize,
    pageSizeOptions,
    totalRows,
    countLoading,
    countError,
    queryMs,
    filterCount,
    reachedEnd,
    editable,
    canInsert,
    readOnlyBanner,
    noPkBanner,
    dirtyCount,
    selectedCount,
    onPageSizeChange,
    onCountRows,
    onClearFilters,
    onAddRow,
    onSave,
    onClearSelection,
  } = props;

  const showing =
    totalRows !== null
      ? `Showing ${formatNumber(rowsLoaded)} of ${formatNumber(totalRows)} rows`
      : `Showing ${formatNumber(rowsLoaded)} rows${reachedEnd ? "" : "+"}`;

  return (
    <div className={styles.root}>
      <span>{showing}</span>
      <span className={styles.label}>·</span>
      <span>
        Page <strong>{Math.max(1, highestLoadedPage)}</strong>
      </span>
      <span className={styles.spacer} />
      {selectedCount >= 2 && (
        <span className={styles.chip}>
          {selectedCount} rows selected
          <button
            type="button"
            className={styles.chipBtn}
            onClick={onClearSelection}
            aria-label="Clear selection"
            title="Clear row selection"
          >
            Clear
          </button>
        </span>
      )}
      {filterCount > 0 && (
        <span className={styles.chip}>
          {filterCount} filter{filterCount === 1 ? "" : "s"}
          <button
            type="button"
            className={styles.chipBtn}
            onClick={onClearFilters}
            aria-label="Clear filters"
            title="Clear filters"
          >
            ×
          </button>
        </span>
      )}
      {readOnlyBanner ? (
        <span className={styles.banner} title="The connection is in read-only mode">
          Read-only connection — edits disabled
        </span>
      ) : noPkBanner ? (
        <span className={styles.banner} title="Existing rows cannot be edited or deleted; INSERT is allowed">
          No primary key — existing rows are not editable
        </span>
      ) : null}
      {canInsert && (
        <button
          type="button"
          className={styles.btn}
          onClick={onAddRow}
          title="Add a new row to the buffer (Cmd-S to commit)"
          aria-label="Add row"
        >
          <Plus size={11} />
          Add row
        </button>
      )}
      {editable && (
        <button
          type="button"
          className={`${styles.btn} ${dirtyCount > 0 ? styles.btnPrimary : ""}`}
          onClick={onSave}
          disabled={dirtyCount === 0}
          title="Open the diff preview (Cmd-S)"
        >
          {dirtyCount > 0 ? `Save (${dirtyCount})` : "Save"}
        </button>
      )}
      {queryMs !== null && (
        <span className={styles.timing}>{queryMs} ms</span>
      )}
      <button
        type="button"
        className={styles.btn}
        onClick={onCountRows}
        disabled={countLoading}
        title={
          countError
            ? `Last count failed: ${countError}`
            : "Run SELECT COUNT(*) honoring active filters"
        }
      >
        {countLoading ? (
          <span className={styles.spinner}>
            <Loader2 size={11} />
          </span>
        ) : (
          "Count rows"
        )}
      </button>
      <label className={styles.label} htmlFor="pg-page-size">
        Page size
      </label>
      <select
        id="pg-page-size"
        className={styles.select}
        value={pageSize}
        onChange={(e) => onPageSizeChange(Number(e.target.value))}
      >
        {pageSizeOptions.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </div>
  );
}
