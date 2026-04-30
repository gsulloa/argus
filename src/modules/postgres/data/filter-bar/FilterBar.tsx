import { useCallback, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, Plus } from "lucide-react";
import { ConditionRow } from "./ConditionRow";
import { ConfirmDialog } from "./ConfirmDialog";
import { OrGroup } from "./OrGroup";
import { RawWhereEditor } from "./RawWhereEditor";
import { compileWhere } from "./compileWhere";
import {
  addOrChildCondition,
  addRootCondition,
  addRootOrGroup,
  emptyCondition,
  emptyTree,
  removeOrChild,
  removeRootChild,
  setOrChild,
  setRootChild,
} from "./treeMutations";
import {
  filterModelEquals,
  type Condition,
  type DataColumn,
  type FilterMode,
  type FilterModel,
  type FilterTree,
} from "../types";
import styles from "./FilterBar.module.css";

export interface FilterBarProps {
  draft: FilterModel;
  applied: FilterModel;
  columns: DataColumn[];
  /** Inline error to surface near the Raw editor (e.g. AppError::Postgres). */
  rawError: string | null;
  onDraftChange(next: FilterModel): void;
  onApply(): void;
  onReset(): void;
  onOpenInSqlEditor(): void;
}

export function FilterBar({
  draft,
  applied,
  columns,
  rawError,
  onDraftChange,
  onApply,
  onReset,
  onOpenInSqlEditor,
}: FilterBarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [showConfirmRawToStructured, setShowConfirmRawToStructured] =
    useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const isDirty = useMemo(
    () => !filterModelEquals(draft, applied),
    [draft, applied],
  );

  const updateTree = useCallback(
    (next: FilterTree) => {
      onDraftChange({ ...draft, tree: next });
    },
    [draft, onDraftChange],
  );

  function setMode(nextMode: FilterMode) {
    if (nextMode === draft.mode) return;
    if (nextMode === "raw") {
      // Structured → Raw: seed editor with compiled WHERE body.
      const compiled = compileWhere(draft, columns);
      onDraftChange({ ...draft, mode: "raw", raw: compiled.body });
      return;
    }
    // Raw → Structured.
    const hasRaw = draft.raw.trim().length > 0;
    if (hasRaw) {
      setShowConfirmRawToStructured(true);
      return;
    }
    // No raw body to lose — just flip.
    onDraftChange({ ...draft, mode: "structured", raw: "" });
  }

  function confirmRawToStructured() {
    onDraftChange({ mode: "structured", tree: emptyTree(), raw: "" });
    setShowConfirmRawToStructured(false);
  }

  // Scoped keyboard shortcuts: Cmd+Enter applies; Esc discards draft.
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const root = rootRef.current;
    if (!root) return;
    if (!root.contains(document.activeElement)) return;
    const isApply =
      (e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.shiftKey;
    if (isApply) {
      e.preventDefault();
      onApply();
      return;
    }
    if (e.key === "Escape" && isDirty) {
      e.preventDefault();
      onDraftChange(applied);
    }
  }

  return (
    <div className={styles.root} ref={rootRef} onKeyDown={onKeyDown}>
      <div className={styles.header}>
        <div className={styles.modeToggle} role="tablist" aria-label="Filter mode">
          <button
            type="button"
            role="tab"
            className={styles.modeBtn}
            data-active={draft.mode === "structured" ? "true" : "false"}
            aria-selected={draft.mode === "structured"}
            onClick={() => setMode("structured")}
          >
            Structured
          </button>
          <button
            type="button"
            role="tab"
            className={styles.modeBtn}
            data-active={draft.mode === "raw" ? "true" : "false"}
            aria-selected={draft.mode === "raw"}
            onClick={() => setMode("raw")}
          >
            Raw SQL
          </button>
        </div>
        <button
          type="button"
          className={styles.collapseBtn}
          aria-label={collapsed ? "Expand filter bar" : "Collapse filter bar"}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
        </button>
      </div>
      {!collapsed && (
        <>
          <div className={styles.body}>
            {draft.mode === "structured" ? (
              <StructuredBody
                tree={draft.tree}
                columns={columns}
                onTreeChange={updateTree}
              />
            ) : (
              <RawBody
                value={draft.raw}
                rawError={rawError}
                onChange={(next) => onDraftChange({ ...draft, raw: next })}
              />
            )}
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.btn}
              onClick={onOpenInSqlEditor}
              title="Open the current applied filters as a SELECT in a new SQL editor tab"
            >
              <ExternalLink size={11} />
              <span style={{ marginLeft: 4 }}>Open in SQL Editor</span>
            </button>
            <span className={styles.spacer} />
            <button type="button" className={styles.btn} onClick={onReset}>
              Reset
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={onApply}
              aria-label={isDirty ? "Apply (unsaved changes)" : "Apply"}
              title="Apply (Cmd+Enter)"
            >
              {isDirty && (
                <span className={styles.dirtyDot} aria-hidden="true" />
              )}
              Apply
            </button>
          </div>
        </>
      )}
      {showConfirmRawToStructured && (
        <ConfirmDialog
          title="Switch to structured?"
          message="Your raw WHERE will be discarded."
          cancelLabel="Cancel"
          confirmLabel="Switch"
          destructive
          onCancel={() => setShowConfirmRawToStructured(false)}
          onConfirm={confirmRawToStructured}
        />
      )}
    </div>
  );
}

interface StructuredBodyProps {
  tree: FilterTree;
  columns: DataColumn[];
  onTreeChange(next: FilterTree): void;
}

function StructuredBody({ tree, columns, onTreeChange }: StructuredBodyProps) {
  return (
    <>
      {tree.children.length === 0 && (
        <span className={styles.empty}>No filters yet — add a row below.</span>
      )}
      {tree.children.map((node, i) => {
        if (node.kind === "condition") {
          const cond: Condition = {
            column: node.column,
            op: node.op,
            value: node.value,
          };
          return (
            <div key={i} className={styles.row}>
              <span className={styles.connector}>{i === 0 ? "" : "AND"}</span>
              <ConditionRow
                condition={cond}
                columns={columns}
                onChange={(next) =>
                  onTreeChange(
                    setRootChild(tree, i, { kind: "condition", ...next }),
                  )
                }
                onRemove={() => onTreeChange(removeRootChild(tree, i))}
              />
            </div>
          );
        }
        return (
          <div key={i} className={styles.row}>
            <span className={styles.connector}>{i === 0 ? "" : "AND"}</span>
            <OrGroup
              group={node}
              columns={columns}
              onUpdateChild={(childIndex, next) =>
                onTreeChange(
                  setOrChild(tree, i, childIndex, {
                    kind: "condition",
                    ...next,
                  }),
                )
              }
              onRemoveChild={(childIndex) =>
                onTreeChange(removeOrChild(tree, i, childIndex))
              }
              onAddChild={() =>
                onTreeChange(addOrChildCondition(tree, i, emptyCondition()))
              }
              onRemoveGroup={() => onTreeChange(removeRootChild(tree, i))}
            />
          </div>
        );
      })}
      <div className={styles.addRow}>
        <button
          type="button"
          className={styles.addBtn}
          onClick={() => onTreeChange(addRootCondition(tree, emptyCondition()))}
        >
          <Plus size={10} /> AND row
        </button>
        <button
          type="button"
          className={styles.addBtn}
          onClick={() => onTreeChange(addRootOrGroup(tree, emptyCondition()))}
        >
          <Plus size={10} /> OR group
        </button>
      </div>
    </>
  );
}

interface RawBodyProps {
  value: string;
  rawError: string | null;
  onChange(next: string): void;
}

function RawBody({ value, rawError, onChange }: RawBodyProps) {
  return (
    <>
      <RawWhereEditor value={value} onChange={onChange} />
      {rawError && <div className={styles.rawError}>{rawError}</div>}
    </>
  );
}
