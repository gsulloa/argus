/**
 * Toolbar — top bar for the DynamoDB Data View tab.
 *
 * Controls:
 *   - Mode toggle: Tabla / JSON / Metadata  (Metadata is a tertiary nav item)
 *   - Run button (fires useDynamoItems.run)
 *   - Reset button (resets builder to defaults)
 *   - Consistent-read toggle
 *   - Reverse-order toggle (Query mode only)
 *   - Page size numeric input (clamps [1, 1000])
 *   - Count button (slot; wired fully in Phase 8 task 13.1)
 *   - Load more button
 *   - Inline "Connection waiting for credentials" notice
 *
 * Phase 9 (task 16.2) will wire the `needsCredentials` disabling; for now
 * the notice is rendered when `needsCredentials` is true but controls are NOT
 * disabled — document decision: deferring disabling to Phase 9 as specified.
 */

import { Loader2, Play, RefreshCw, AlertTriangle, Hash, ChevronDown } from "lucide-react";
import type { BuilderState } from "./types";
import type { DynamoItemsStatus } from "./useDynamoItems";
import type { CountResult } from "./BottomBar";
import styles from "./Toolbar.module.css";
import { noAutoCorrectProps } from "../../shared/text-input-hygiene";

export type ViewMode = "tabla" | "json" | "metadata";

export interface ToolbarProps {
  // --- View mode ---
  viewMode: ViewMode;
  onViewModeChange(mode: ViewMode): void;

  // --- Builder state ---
  builder: BuilderState;
  onBuilderChange(next: BuilderState): void;

  // --- Query status ---
  status: DynamoItemsStatus;
  lastEvaluatedKey: Record<string, unknown> | null;

  // --- Actions ---
  onRun(): void;
  onReset(): void;
  onLoadMore(): void;

  // --- Count slot (Phase 8 task 13.1 wires this fully) ---
  countLoading: boolean;
  countResult: CountResult | undefined;
  onCount(): void;

  // --- Credentials ---
  needsCredentials: boolean;

  // --- Page size (separate from builder — persisted independently) ---
  pageSize: number;
  onPageSizeChange(next: number): void;

  // --- Builder validity (from QueryBuilder via DataViewTab) ---
  runDisabled?: boolean;
  runDisabledReason?: string;

  // --- Insert affordance (task 8.8) ---
  /** Called when the user clicks the + Insert button. */
  onInsert?: () => void;
  /** When true, the + button is hidden. */
  isReadOnly?: boolean;

  // --- Optimistic locking (task 10.3) ---
  /** Whether the "Use ConditionExpression on update" toggle is on. */
  useConditionExpression?: boolean;
  /** Called when the toggle changes. */
  onUseConditionExpressionChange?: (next: boolean) => void;
  /** Called when the user clicks "Locking…" to open the config dialog. */
  onOpenLockingDialog?: () => void;
}

export function Toolbar({
  viewMode,
  onViewModeChange,
  builder,
  onBuilderChange,
  status,
  lastEvaluatedKey,
  onRun,
  onReset,
  onLoadMore,
  countLoading,
  onCount,
  needsCredentials,
  pageSize,
  onPageSizeChange,
  runDisabled = false,
  runDisabledReason,
  onInsert,
  isReadOnly = false,
  useConditionExpression = false,
  onUseConditionExpressionChange,
  onOpenLockingDialog,
}: ToolbarProps) {
  const isLoading = status === "loading";
  // While waiting for credentials, all interactive controls are disabled (task 16.2).
  const canLoadMore = lastEvaluatedKey !== null && !isLoading && !needsCredentials;
  const isQueryMode = builder.mode === "query";
  const runBlocked = isLoading || runDisabled || needsCredentials;

  function handlePageSizeCommit(raw: string) {
    const n = parseInt(raw, 10);
    if (isNaN(n)) return;
    const clamped = Math.max(1, Math.min(1000, n));
    onPageSizeChange(clamped);
  }

  return (
    <div className={styles.root}>
      {/* View mode toggle: Tabla / JSON */}
      <div className={styles.modeGroup} role="group" aria-label="View mode">
        <button
          type="button"
          className={`${styles.modeBtn} ${viewMode === "tabla" ? styles.modeBtnActive : ""}`}
          onClick={() => onViewModeChange("tabla")}
          aria-pressed={viewMode === "tabla"}
          title="Tabla mode — grid view"
        >
          Tabla
        </button>
        <button
          type="button"
          className={`${styles.modeBtn} ${viewMode === "json" ? styles.modeBtnActive : ""}`}
          onClick={() => onViewModeChange("json")}
          aria-pressed={viewMode === "json"}
          title="JSON mode — per-item JSON blocks"
        >
          JSON
        </button>
      </div>

      <div className={styles.sep} />

      {/* Metadata tertiary nav */}
      <button
        type="button"
        className={`${styles.btn} ${viewMode === "metadata" ? styles.btnActive : ""}`}
        onClick={() => onViewModeChange(viewMode === "metadata" ? "tabla" : "metadata")}
        aria-pressed={viewMode === "metadata"}
        title="Table metadata — key schema, indexes, ARN"
      >
        Metadata
      </button>

      <div className={styles.sep} />

      {/* Run */}
      <button
        type="button"
        className={styles.btnPrimary}
        onClick={onRun}
        disabled={runBlocked}
        title={runDisabled && runDisabledReason ? runDisabledReason : "Run scan / query (⌘R)"}
        aria-label="Run"
        data-testid="toolbar-run"
      >
        <Play size={10} />
        Run
      </button>

      {/* Reset */}
      <button
        type="button"
        className={styles.btn}
        onClick={onReset}
        disabled={isLoading}
        title="Reset builder to defaults (⌘⇧R)"
        aria-label="Reset"
      >
        <RefreshCw size={10} />
        Reset
      </button>

      <div className={styles.sep} />

      {/* Consistent read toggle */}
      <button
        type="button"
        className={`${styles.btn} ${builder.consistentRead ? styles.btnActive : ""}`}
        onClick={() =>
          onBuilderChange({ ...builder, consistentRead: !builder.consistentRead })
        }
        aria-pressed={builder.consistentRead}
        title={
          builder.consistentRead
            ? "Consistent read ON — click to disable"
            : "Consistent read OFF — click to enable"
        }
      >
        Consistent
      </button>

      {/* Reverse-order toggle — Query mode only */}
      {isQueryMode && (
        <button
          type="button"
          className={`${styles.btn} ${!builder.scanIndexForward ? styles.btnActive : ""}`}
          onClick={() =>
            onBuilderChange({
              ...builder,
              scanIndexForward: !builder.scanIndexForward,
            })
          }
          aria-pressed={!builder.scanIndexForward}
          title={
            builder.scanIndexForward
              ? "Sort ascending — click to reverse"
              : "Sort descending — click to restore"
          }
        >
          <ChevronDown size={10} style={builder.scanIndexForward ? {} : { transform: "rotate(180deg)" }} />
          {builder.scanIndexForward ? "Asc" : "Desc"}
        </button>
      )}

      <div className={styles.sep} />

      {/* Page size */}
      <label className={styles.pageSizeLabel} htmlFor="dynamo-page-size">
        Limit
      </label>
      <input
        id="dynamo-page-size"
        type="number"
        {...noAutoCorrectProps}
        className={styles.pageSizeInput}
        min={1}
        max={1000}
        step={1}
        defaultValue={pageSize}
        key={pageSize} // reset input when persisted value loads
        onBlur={(e) => handlePageSizeCommit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handlePageSizeCommit(e.currentTarget.value);
        }}
        aria-label="Page size (1–1000)"
        title="Items per page (1–1000). Persisted per table."
      />

      <div className={styles.sep} />

      {/* Count button (slot — Phase 8 task 13.1 fully wires this) */}
      <button
        type="button"
        className={styles.btn}
        onClick={onCount}
        disabled={countLoading || isLoading || needsCredentials}
        title={
          needsCredentials
            ? "Connection waiting for credentials"
            : "Count all matching items (full table scan with SELECT=COUNT)"
        }
        aria-label="Count items"
      >
        {countLoading ? (
          <Loader2 size={10} className={styles.spinnerIcon} />
        ) : (
          <Hash size={10} />
        )}
        Count
      </button>

      {/* Load more */}
      <button
        type="button"
        className={styles.btn}
        onClick={onLoadMore}
        disabled={!canLoadMore}
        title={
          lastEvaluatedKey === null
            ? "No more pages — all items loaded"
            : "Load next page"
        }
        aria-label="Load more"
      >
        Load more
      </button>

      <span className={styles.spacer} />

      {/* Read-only badge — visible only when isReadOnly (task 12.1) */}
      {isReadOnly && (
        <span
          className={styles.readOnlyBadge}
          data-testid="toolbar-readonly-badge"
          aria-label="Read-only connection"
          title="This connection is read-only — edits are disabled"
        >
          Read-only
        </span>
      )}

      {/* Insert button — hidden on read-only connections (task 8.8) */}
      {!isReadOnly && onInsert && (
        <button
          type="button"
          className={styles.btn}
          onClick={onInsert}
          title="Insert item (⌘N)"
          aria-label="Insert item"
          data-testid="toolbar-insert-btn"
        >
          + Insert
        </button>
      )}

      {/* Optimistic locking controls (task 10.3) — hidden on read-only */}
      {!isReadOnly && onUseConditionExpressionChange && (
        <>
          <div className={styles.sep} />
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              cursor: "pointer",
              fontSize: 12,
              color: "var(--text-muted)",
              fontFamily: "var(--font-sans, system-ui)",
              userSelect: "none",
            }}
            title="When on, every update carries attribute_exists(pk) AND #version = :prev (requires version attribute to be configured)"
          >
            <input
              type="checkbox"
              data-testid="use-condition-expression-toggle"
              checked={useConditionExpression}
              onChange={(e) => onUseConditionExpressionChange(e.target.checked)}
              style={{ cursor: "pointer" }}
            />
            Use CondExpr
          </label>
          {onOpenLockingDialog && (
            <button
              type="button"
              className={styles.btn}
              onClick={onOpenLockingDialog}
              title="Configure optimistic locking version attribute"
              aria-label="Optimistic locking settings"
              data-testid="toolbar-locking-btn"
            >
              Locking…
            </button>
          )}
        </>
      )}

      {/* Inline credentials notice */}
      {needsCredentials && (
        <span className={styles.credNotice} aria-live="polite">
          <AlertTriangle size={11} />
          Connection waiting for credentials
        </span>
      )}
    </div>
  );
}
