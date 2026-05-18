import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronDown, Check } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ConditionRow } from "./ConditionRow";
import {
  addRow,
  removeRow,
  setRow,
  setEnabled,
  setCombinator,
  clearAllRows,
} from "./treeMutations";
import {
  filterModelEquals,
  filterRowEquals,
  isCompleteRow,
  type DataColumn,
  type FilterModel,
  type FilterRow,
  EMPTY_FILTER_ROW,
} from "../types";
import {
  FilterBarShell,
  FilterBarBody,
  FilterKeyHint,
  type FilterBarHandle,
} from "../../../shared/filter-bar";
import styles from "./FilterBar.module.css";

// ─── FilterBarProps ───────────────────────────────────────────────────────────

export interface FilterBarProps {
  draft: FilterModel;
  applied: FilterModel;
  columns: DataColumn[];
  onDraftChange(next: FilterModel): void;
  /** Apply All — commits enabled+complete rows joined by draft.combinator. */
  onApplyAll(): void;
  /** Per-row Apply — replaces applied with [thisRow], preserving combinator. */
  onApplyOnlyRow(index: number): void;
  /** Opens the SQL editor with the compiled applied WHERE. */
  onSqlClick(): void;
  /** Hide the bar. */
  onClose(): void;
}

// ─── buildAppliedSet ─────────────────────────────────────────────────────────

/**
 * Returns a Set of draft row indices whose (column, op, value) triple matches
 * any row in `applied.rows` (ignoring `enabled`).
 */
function buildAppliedSet(
  draftRows: FilterRow[],
  appliedRows: FilterRow[],
): Set<number> {
  const s = new Set<number>();
  for (let i = 0; i < draftRows.length; i++) {
    const dr = draftRows[i]!;
    for (const ar of appliedRows) {
      if (filterRowEquals(dr, ar)) {
        s.add(i);
        break;
      }
    }
  }
  return s;
}

// ─── FilterBar ───────────────────────────────────────────────────────────────

export const FilterBar = forwardRef<FilterBarHandle, FilterBarProps>(
  function FilterBar(
    {
      draft,
      applied,
      columns,
      onDraftChange,
      onApplyAll,
      onApplyOnlyRow,
      onSqlClick,
      onClose,
    },
    ref,
  ) {
    const rootRef = useRef<HTMLDivElement | null>(null);

    // Transient "no filters enabled" inline status.
    const [transientStatus, setTransientStatus] = useState<string | null>(null);
    const transientTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const isDirty = useMemo(
      () => !filterModelEquals(draft, applied),
      [draft, applied],
    );

    // Per-draft-row Applied set.
    const appliedSet = useMemo(
      () => buildAppliedSet(draft.rows, applied.rows),
      [draft.rows, applied.rows],
    );

    // Ensure at least one row is always rendered.
    const rows = draft.rows.length > 0 ? draft.rows : [EMPTY_FILTER_ROW];

    // ── Apply All handler with "no filters" feedback ──────────────────────────

    const handleApplyAll = useCallback(() => {
      const eligible = draft.rows.filter((r) => r.enabled && isCompleteRow(r));
      if (eligible.length === 0) {
        if (transientTimerRef.current) clearTimeout(transientTimerRef.current);
        setTransientStatus("No filters enabled");
        transientTimerRef.current = setTimeout(() => {
          setTransientStatus(null);
        }, 2000);
      }
      onApplyAll();
    }, [draft.rows, onApplyAll]);

    // ── Draft mutation helpers ─────────────────────────────────────────────────

    const handleRowChange = useCallback(
      (i: number, next: FilterRow) => {
        onDraftChange({ ...draft, rows: setRow(draft, i, next).rows });
      },
      [draft, onDraftChange],
    );

    const handleSetEnabled = useCallback(
      (i: number, en: boolean) => {
        onDraftChange(setEnabled(draft, i, en));
      },
      [draft, onDraftChange],
    );

    const handleInsertBelow = useCallback(
      (i: number) => {
        onDraftChange(addRow(draft, i + 1));
      },
      [draft, onDraftChange],
    );

    const handleRemove = useCallback(
      (i: number) => {
        onDraftChange(removeRow(draft, i));
      },
      [draft, onDraftChange],
    );

    // ── Unset ─────────────────────────────────────────────────────────────────

    const handleUnset = useCallback(() => {
      onDraftChange(clearAllRows(draft));
    }, [draft, onDraftChange]);

    // ── Combinator change (from chevron menu) ─────────────────────────────────

    const handleCombinatorAndApply = useCallback(
      (combo: "AND" | "OR") => {
        const next = setCombinator(draft, combo);
        onDraftChange(next);
        // Apply with new combinator immediately.
        const eligible = next.rows.filter((r) => r.enabled && isCompleteRow(r));
        if (eligible.length === 0) {
          if (transientTimerRef.current) clearTimeout(transientTimerRef.current);
          setTransientStatus("No filters enabled");
          transientTimerRef.current = setTimeout(() => setTransientStatus(null), 2000);
        }
        onApplyAll();
      },
      [draft, onDraftChange, onApplyAll],
    );

    // ── Keyboard shortcuts ────────────────────────────────────────────────────

    const onKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        const root = rootRef.current;
        if (!root) return;
        if (!root.contains(document.activeElement)) return;

        // Don't steal keys from CodeMirror.
        if ((document.activeElement as HTMLElement | null)?.closest(".cm-editor")) return;

        const meta = e.metaKey || e.ctrlKey;
        if (!meta) return;

        // ⌘F → close (hide) the bar when focused inside it.
        if (e.key === "f" && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          onClose();
          return;
        }

        // ⌘↵ → Apply All with AND.
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const next = setCombinator(draft, "AND");
          onDraftChange(next);
          handleApplyAll();
          return;
        }

        // ⇧⌘↵ → Apply All with OR.
        if (e.key === "Enter" && e.shiftKey) {
          e.preventDefault();
          const next = setCombinator(draft, "OR");
          onDraftChange(next);
          handleApplyAll();
          return;
        }

        // ⌘I → insert row below focused row.
        if (e.key === "i" && !e.shiftKey) {
          e.preventDefault();
          const activeEl = document.activeElement as HTMLElement | null;
          const rowEl = activeEl?.closest("[data-filter-row-index]") as HTMLElement | null;
          const idx = rowEl ? parseInt(rowEl.dataset.filterRowIndex ?? "-1", 10) : -1;
          const insertAt = idx >= 0 ? idx + 1 : draft.rows.length;
          onDraftChange(addRow(draft, insertAt));
          requestAnimationFrame(() => {
            const newRowEl = root.querySelector(
              `[data-filter-row-index="${insertAt}"] [data-filter-control="column"] button`,
            ) as HTMLElement | null;
            newRowEl?.focus();
          });
          return;
        }

        // ⌘⇧I → remove focused row (or clear if last).
        if (e.key === "i" && e.shiftKey) {
          e.preventDefault();
          const activeEl = document.activeElement as HTMLElement | null;
          const rowEl = activeEl?.closest("[data-filter-row-index]") as HTMLElement | null;
          const idx = rowEl ? parseInt(rowEl.dataset.filterRowIndex ?? "-1", 10) : -1;
          const control = (activeEl?.closest("[data-filter-control]") as HTMLElement | null)
            ?.dataset.filterControl ?? "column";
          const nextDraft = removeRow(draft, idx >= 0 ? idx : 0);
          onDraftChange(nextDraft);
          const focusIdx = Math.max(0, idx - 1);
          requestAnimationFrame(() => {
            const targetEl = root.querySelector(
              `[data-filter-row-index="${focusIdx}"] [data-filter-control="${control}"]`,
            ) as HTMLElement | null;
            const focusable = targetEl?.tagName === "SPAN"
              ? (targetEl.querySelector("button, input, select") as HTMLElement | null)
              : targetEl;
            focusable?.focus();
          });
          return;
        }

        // ⌘↑ → move focus to same control on row above.
        if (e.key === "ArrowUp") {
          e.preventDefault();
          const activeEl = document.activeElement as HTMLElement | null;
          const rowEl = activeEl?.closest("[data-filter-row-index]") as HTMLElement | null;
          if (!rowEl) return;
          const idx = parseInt(rowEl.dataset.filterRowIndex ?? "0", 10);
          if (idx <= 0) return;
          const control = (activeEl?.closest("[data-filter-control]") as HTMLElement | null)
            ?.dataset.filterControl ?? "value";
          const targetEl = root.querySelector(
            `[data-filter-row-index="${idx - 1}"] [data-filter-control="${control}"]`,
          ) as HTMLElement | null;
          const focusable = targetEl?.tagName === "SPAN"
            ? (targetEl.querySelector("button, input, select") as HTMLElement | null)
            : targetEl;
          focusable?.focus();
          return;
        }

        // ⌘↓ → move focus to same control on row below.
        if (e.key === "ArrowDown") {
          e.preventDefault();
          const activeEl = document.activeElement as HTMLElement | null;
          const rowEl = activeEl?.closest("[data-filter-row-index]") as HTMLElement | null;
          if (!rowEl) return;
          const idx = parseInt(rowEl.dataset.filterRowIndex ?? "0", 10);
          if (idx >= draft.rows.length - 1) return;
          const control = (activeEl?.closest("[data-filter-control]") as HTMLElement | null)
            ?.dataset.filterControl ?? "value";
          const targetEl = root.querySelector(
            `[data-filter-row-index="${idx + 1}"] [data-filter-control="${control}"]`,
          ) as HTMLElement | null;
          const focusable = targetEl?.tagName === "SPAN"
            ? (targetEl.querySelector("button, input, select") as HTMLElement | null)
            : targetEl;
          focusable?.focus();
          return;
        }

        // ⌘← → open column picker on focused row.
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          const activeEl = document.activeElement as HTMLElement | null;
          const rowEl = activeEl?.closest("[data-filter-row-index]") as HTMLElement | null;
          if (!rowEl) return;
          const idx = parseInt(rowEl.dataset.filterRowIndex ?? "0", 10);
          const colTrigger = root.querySelector(
            `[data-filter-row-index="${idx}"] [data-filter-control="column"] button`,
          ) as HTMLElement | null;
          colTrigger?.click();
          colTrigger?.focus();
          return;
        }
      },
      [rootRef, draft, onDraftChange, handleApplyAll, onClose],
    );

    // ── Imperative focus handle ───────────────────────────────────────────────

    useImperativeHandle(
      ref,
      () => ({
        focus() {
          const root = rootRef.current;
          if (!root) return;
          // Try first row's value input.
          const valueInput = root.querySelector(
            '[data-filter-row-index="0"] [data-filter-control="value"] input',
          ) as HTMLElement | null;
          if (valueInput) {
            valueInput.focus();
            return;
          }
          // Fallback: column picker button.
          const colBtn = root.querySelector(
            '[data-filter-row-index="0"] [data-filter-control="column"] button',
          ) as HTMLElement | null;
          colBtn?.focus();
        },
      }),
      [],
    );

    // ─────────────────────────────────────────────────────────────────────────

    const applyAllLabel =
      draft.combinator === "OR" ? "Apply All (OR)" : "Apply All";

    return (
      <div ref={rootRef} onKeyDown={onKeyDown} className={styles.root} data-filter-bar-root="true">
        <FilterBarShell>
          <FilterBarBody>
            {rows.map((row, i) => (
              <ConditionRow
                key={i}
                row={row}
                index={i}
                totalRows={rows.length}
                isApplied={appliedSet.has(i)}
                columns={columns}
                isFocusTarget={i === 0}
                onChange={(next) => handleRowChange(i, next)}
                onSetEnabled={(en) => handleSetEnabled(i, en)}
                onApplyOnly={() => onApplyOnlyRow(i)}
                onInsertBelow={() => handleInsertBelow(i)}
                onRemove={() => handleRemove(i)}
              />
            ))}
          </FilterBarBody>

          {/* Footer */}
          <footer className={styles.footer}>
            <div className={styles.footerLeft}>
              {/* Export placeholder */}
              <button
                type="button"
                className={styles.footerBtn}
                disabled
                aria-disabled="true"
                title="Export coming soon"
              >
                Export
              </button>

              {/* SQL button */}
              <button
                type="button"
                className={styles.footerBtn}
                onClick={onSqlClick}
              >
                SQL
              </button>

              {/* Shortcut hints */}
              <span className={styles.footerHints}>
                <span className={styles.hintItem}>
                  Show: <FilterKeyHint keys="⌘F" />
                </span>
                <span className={styles.hintItem}>
                  Insert: <FilterKeyHint keys="⌘I" />
                </span>
                <span className={styles.hintItem}>
                  Remove: <FilterKeyHint keys="⌘⇧I" />
                </span>
                <span className={styles.hintItem}>
                  Apply All: <FilterKeyHint keys="⌘↵" />
                </span>
                <span className={styles.hintItem}>
                  Up: <FilterKeyHint keys="⌘↑" />
                </span>
                <span className={styles.hintItem}>
                  Down: <FilterKeyHint keys="⌘↓" />
                </span>
                <span className={styles.hintItem}>
                  Columns: <FilterKeyHint keys="⌘←" />
                </span>
              </span>

              {/* Operator: Unset */}
              <span className={styles.hintItem}>
                Operator:{" "}
                <button
                  type="button"
                  className={styles.unsetBtn}
                  onClick={handleUnset}
                >
                  Unset
                </button>
              </span>
            </div>

            {/* Right side: dirty pip + Apply All composed button */}
            <div className={styles.footerRight}>
              {isDirty && <span className={styles.dirtyPip} aria-label="Unsaved changes" title="Unsaved changes" />}

              {/* Transient status */}
              {transientStatus && (
                <span className={styles.transientStatus}>{transientStatus}</span>
              )}

              {/* Apply All composed button */}
              <div className={styles.applyAllComposed}>
                <button
                  type="button"
                  className={styles.applyAllPrimary}
                  onClick={handleApplyAll}
                >
                  {applyAllLabel}
                </button>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      className={styles.applyAllChevron}
                      aria-label="Apply All options"
                    >
                      <ChevronDown size={10} />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      className={styles.applyAllMenu}
                      align="end"
                      sideOffset={4}
                    >
                      <DropdownMenu.Item
                        className={styles.applyAllMenuItem}
                        onSelect={() => handleCombinatorAndApply("AND")}
                      >
                        <span className={styles.menuItemCheck}>
                          {draft.combinator === "AND" && <Check size={11} />}
                        </span>
                        <span>Apply All Checked Filters with AND – Default</span>
                        <kbd className={styles.menuItemHint}>⌘↵</kbd>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        className={styles.applyAllMenuItem}
                        onSelect={() => handleCombinatorAndApply("OR")}
                      >
                        <span className={styles.menuItemCheck}>
                          {draft.combinator === "OR" && <Check size={11} />}
                        </span>
                        <span>Apply All Checked Filters with OR</span>
                        <kbd className={styles.menuItemHint}>⇧⌘↵</kbd>
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
            </div>
          </footer>
        </FilterBarShell>
      </div>
    );
  },
);
