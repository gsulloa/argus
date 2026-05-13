import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from "react";
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
  setRootCombinator,
} from "./treeMutations";
import {
  filterModelEquals,
  getRootCombinator,
  type Condition,
  type DataColumn,
  type FilterMode,
  type FilterModel,
  type FilterTree,
} from "../types";
import {
  FilterBarShell,
  FilterBarHeader,
  FilterBarBody,
  FilterBarActions,
  FilterConnector,
  FilterRowAddButton,
  FilterKeyHint,
  PrimaryButton,
  SecondaryButton,
  EmptyBodyRow,
  RootCombinatorToggle,
  type FilterBarHandle,
} from "../../../shared/filter-bar";
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
  /** Called when the user clicks the per-row Apply button on a root child. */
  onApplyOnlyRow?: (index: number) => void;
}

export const FilterBar = forwardRef<FilterBarHandle, FilterBarProps>(function FilterBar(
  {
    draft,
    applied,
    columns,
    rawError,
    onDraftChange,
    onApply,
    onReset,
    onOpenInSqlEditor,
    onApplyOnlyRow,
  },
  ref,
) {
  const [collapsed, setCollapsed] = useState(false);
  const [showConfirmRawToStructured, setShowConfirmRawToStructured] =
    useState(false);
  // rootRef attaches to the outermost DOM element so keyboard-shortcut
  // handlers can scope containment checks to the entire filter bar.
  const rootRef = useRef<HTMLDivElement | null>(null);
  // bodyRef allows focus() to query first focus target within the body.
  const bodyRef = useRef<HTMLDivElement | null>(null);

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

  // Imperative focus() method exposed via ref.
  // Resolves focus target in order per Decision 2.
  useImperativeHandle(
    ref,
    () => ({
      focus() {
        function focusFirst() {
          const body = bodyRef.current;
          if (!body) return;
          // Find the element marked as the focus target.
          const target = body.querySelector<HTMLElement>(
            "[data-filter-focus-target='true']",
          );
          if (target) {
            // If the target is a CodeMirror container, focus its contenteditable.
            const cmContent = target.querySelector<HTMLElement>(".cm-content");
            if (cmContent) {
              cmContent.focus();
              return;
            }
            // If the target itself is focusable (button, input, etc.), focus it directly.
            const tag = target.tagName;
            if (tag === "BUTTON" || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
              target.focus();
              return;
            }
            // Otherwise, find the first focusable child inside the target.
            const child = target.querySelector<HTMLElement>(
              "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]",
            );
            child?.focus();
            return;
          }
          // Fallback: first focusable element inside a container marked with the attribute.
          const container = body.querySelector<HTMLElement>(
            "[data-filter-focus-target-container='true']",
          );
          const child = container?.querySelector<HTMLElement>(
            "button:not([disabled]), input:not([disabled]), textarea:not([disabled])",
          );
          child?.focus();
        }

        if (collapsed) {
          setCollapsed(false);
          // Wait for the state-driven reveal before querying the DOM.
          requestAnimationFrame(focusFirst);
          return;
        }
        focusFirst();
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collapsed, draft.mode, draft.tree.children.length],
  );

  // The outer wrapper is a display:contents div that carries the ref and
  // onKeyDown handler. display:contents removes its layout box so FilterBarShell
  // remains the visual root — the wrapper is transparent to CSS layout while
  // still capturing DOM events and providing the rootRef containment check.
  return (
    <div ref={rootRef} onKeyDown={onKeyDown} className={styles.root}>
      <FilterBarShell>
        <FilterBarHeader>
          {/*
           * Mode toggle: kept as role="tablist" / role="tab" to preserve the
           * existing test contract (getByRole("tab", { name: "Structured" })).
           * TODO: migrate to FilterSegmentedToggle once tests are updated to
           * query role="radio" instead of role="tab".
           */}
          <div
            className={styles.modeToggle}
            role="tablist"
            aria-label="Filter mode"
          >
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
        </FilterBarHeader>
        {!collapsed && (
          <>
            <FilterBarBody>
              <div ref={bodyRef} style={{ display: "contents" }}>
                {draft.mode === "structured" ? (
                  <StructuredBody
                    tree={draft.tree}
                    columns={columns}
                    onTreeChange={updateTree}
                    onApplyOnlyRow={onApplyOnlyRow}
                  />
                ) : (
                  <RawBody
                    value={draft.raw}
                    rawError={rawError}
                    onChange={(next) => onDraftChange({ ...draft, raw: next })}
                  />
                )}
              </div>
            </FilterBarBody>
            <FilterBarActions
              left={
                <>
                  <SecondaryButton onClick={onOpenInSqlEditor} ariaLabel="Open in SQL Editor">
                    <ExternalLink size={11} />
                    <span style={{ marginLeft: 4 }}>Open in SQL Editor</span>
                  </SecondaryButton>
                  <SecondaryButton onClick={onReset}>Reset</SecondaryButton>
                  <FilterKeyHint keys="⎋" />
                </>
              }
              right={
                <>
                  <FilterKeyHint keys="⌘↵" />
                  <PrimaryButton
                    onClick={onApply}
                    dirty={isDirty}
                    ariaLabel={isDirty ? "Apply (unsaved changes)" : "Apply"}
                  >
                    Apply
                  </PrimaryButton>
                </>
              }
            />
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
      </FilterBarShell>
    </div>
  );
});

interface StructuredBodyProps {
  tree: FilterTree;
  columns: DataColumn[];
  onTreeChange(next: FilterTree): void;
  onApplyOnlyRow?: (index: number) => void;
}

function StructuredBody({ tree, columns, onTreeChange, onApplyOnlyRow }: StructuredBodyProps) {
  if (tree.children.length === 0) {
    return (
      <EmptyBodyRow label="No filters yet">
        {/* data-filter-focus-target-container marks the first add button for
            keyboard focus routing (⌘F → focus()). */}
        <span data-filter-focus-target-container="true" style={{ display: "contents" }}>
          <FilterRowAddButton
            onClick={() => onTreeChange(addRootCondition(tree, emptyCondition()))}
          >
            <Plus size={10} /> AND row
          </FilterRowAddButton>
        </span>
        <FilterRowAddButton
          onClick={() => onTreeChange(addRootOrGroup(tree, emptyCondition()))}
        >
          <Plus size={10} /> OR group
        </FilterRowAddButton>
      </EmptyBodyRow>
    );
  }

  const rootCombinator = getRootCombinator(tree);

  return (
    <div className={styles.structuredBody}>
      {tree.children.map((node, i) => {
        if (node.kind === "condition") {
          const cond: Condition = {
            column: node.column,
            op: node.op,
            value: node.value,
          };
          return (
            <div key={i} className={styles.row}>
              {i > 0 && <FilterConnector label={rootCombinator} />}
              <ConditionRow
                condition={cond}
                columns={columns}
                isFocusTarget={i === 0}
                onChange={(next) =>
                  onTreeChange(
                    setRootChild(tree, i, { kind: "condition", ...next }),
                  )
                }
                onRemove={() => onTreeChange(removeRootChild(tree, i))}
                onApplyOnly={onApplyOnlyRow ? () => onApplyOnlyRow(i) : undefined}
              />
            </div>
          );
        }
        return (
          <div key={i} className={styles.row}>
            {i > 0 && <FilterConnector label={rootCombinator} />}
            <OrGroup
              group={node}
              columns={columns}
              isFocusTarget={i === 0}
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
              onApplyOnly={onApplyOnlyRow ? () => onApplyOnlyRow(i) : undefined}
            />
          </div>
        );
      })}
      <div className={styles.addRow}>
        <RootCombinatorToggle
          value={rootCombinator}
          onChange={(c) => onTreeChange(setRootCombinator(tree, c))}
        />
        <FilterRowAddButton
          onClick={() => onTreeChange(addRootCondition(tree, emptyCondition()))}
        >
          <Plus size={10} /> AND row
        </FilterRowAddButton>
        <FilterRowAddButton
          onClick={() => onTreeChange(addRootOrGroup(tree, emptyCondition()))}
        >
          <Plus size={10} /> OR group
        </FilterRowAddButton>
      </div>
    </div>
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
