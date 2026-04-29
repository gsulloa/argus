import { Loader2 } from "lucide-react";
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
  onPageSizeChange(next: number): void;
  onCountRows(): void;
  onClearFilters(): void;
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
    onPageSizeChange,
    onCountRows,
    onClearFilters,
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
