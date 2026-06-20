/**
 * DataViewTab — DynamoDB data view tab kind "dynamo-data-view".
 *
 * Orchestrates:
 *   - Toolbar (mode toggle, Run/Reset, page size, Count slot, Load more)
 *   - QueryBuilder (Scan vs Query, index picker, filter rows)
 *   - TabView / JsonView (virtualized results in Tabla or JSON mode)
 *   - MetadataView (reachable from toolbar "Metadata" button)
 *   - Inspector (resizable inspector dock)
 *   - BottomBar (items loaded, count result)
 *
 * Design decisions:
 *   (a) Does NOT auto-fetch on open — user must click Run. Rationale: the
 *       page size and mode are persisted, but the user may not have reviewed
 *       the metadata yet; surprising them with a Scan hitting AWS capacity is
 *       worse than requiring one click.
 *   (b) Metadata sub-view is toggled from a toolbar button ("Metadata") that
 *       replaces the results panel. It is NOT an overlay; it shares the same
 *       content area so the layout stays flat and predictable.
 *   (c) ⌘R/⌘⇧R uses useShortcuts with `whenInInput: true` so shortcuts fire
 *       from inside form controls. CodeMirror skipping: the hook's
 *       `isTypingTarget` already excludes `.cm-content` (contentEditable div)
 *       only when `whenInInput` is false. Since the shortcut fires from
 *       inputs, we need an explicit CodeMirror guard. We check whether the
 *       focused element is inside a `.cm-editor` container and bail out.
 *   (d) `needsCredentials` is derived from the persisted connection params
 *       (task 16.2): `connection.params.needs_credentials === true`. Controls
 *       (Run, Load more, Count, index, mode) are disabled while true. The
 *       Toolbar shows an inline "Connection waiting for credentials" notice.
 *   (e) `dynamo:credentials-refreshed:ui` auto-resume is handled by the
 *       `useDynamoItems` hook (task 16.1) — no extra logic needed here.
 *
 * Stable tab id: `dynamotbl:<connectionId>:<tableName>`
 * Tab kind: "dynamo-data-view"
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { TabRegistry } from "@/platform/shell/tabs/TabRegistry";
import { useShortcuts } from "@/platform/shell/useShortcuts";
import { useSetting } from "@/platform/settings/useSetting";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { DYNAMO_KIND } from "@/modules/dynamo/types";
import type { DynamoParams } from "@/modules/dynamo/types";
import { dynamoTablesApi } from "@/modules/dynamo/tables/api";
import type { TableDescription } from "@/modules/dynamo/tables/types";
import type { Tab } from "@/platform/shell/tabs/types";
import { useCloseConfirm, useActivateConfirm } from "@/platform/shell/tabs/useCloseConfirm";
import { useDynamoItems } from "./useDynamoItems";
import { useDynamoSort } from "./useDynamoSort";
import { useDynamoInspectorWidth } from "./useInspectorWidth";
import { useCount } from "./useCount";
import { useTableModels } from "./useTableModels";
import type { BuilderState, AttributeMap, AttributeValue } from "./types";
import { Toolbar, type ViewMode } from "./Toolbar";
import { MetadataView } from "./MetadataView";
import { BottomBar } from "./BottomBar";
import { QueryBuilder } from "./QueryBuilder";
import { TabView, type EditingCell, type SelectGesture } from "./TabView";
import { JsonView } from "./JsonView";
import { Inspector } from "./Inspector";
import { dynamoUpdateItem } from "./api";
import type { FilterBarHandle } from "@/modules/shared/filter-bar";
import { useToast } from "@/platform/toast";
import { InsertModal } from "./edit/InsertModal";
import { DeleteConfirmationModal, type DeleteRow } from "./edit/DeleteConfirmationModal";
import { OptimisticLockingDialog } from "./edit/OptimisticLockingDialog";
import { buildLockingCondition } from "./edit/lockingCondition";
import { useUnsavedDraft } from "./edit/useUnsavedDraft";
import { DiscardChangesDialog } from "./edit/DiscardChangesDialog";
import { ModelEditor } from "./ModelEditor";
import { LinkFolderPrompt } from "./LinkFolderPrompt";
import { InspectorReview } from "./InspectorReview";
import { saveModel, deleteModel, getProjectSource, setProjectSource } from "./api";
import { useModelInspector } from "./useModelInspector";
import { useResolvedProviderId, useAiSettings } from "@/modules/ai/store";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import type { DynamoModel, ModelDraft } from "./types";
import styles from "./DataViewTab.module.css";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DYNAMO_DATA_VIEW_KIND = "dynamo-data-view";

// ---------------------------------------------------------------------------
// Payload type
// ---------------------------------------------------------------------------

export interface DynamoDataViewPayload {
  connectionId: string;
  connectionName: string;
  tableName: string;
  describe: TableDescription | null;
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isPayload(v: unknown): v is DynamoDataViewPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.connectionId === "string" &&
    typeof o.connectionName === "string" &&
    typeof o.tableName === "string" &&
    (o.describe === null || typeof o.describe === "object")
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if the focused element is inside a CodeMirror editor. */
function focusIsInCodeMirror(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  return el.closest(".cm-editor") !== null;
}

/**
 * Resolves the key attribute names (pk + optional sk) for the active index.
 * Mirrors the helper in Inspector.tsx — duplicated to avoid coupling modules.
 */
function resolveKeyNamesForEdit(
  describe: TableDescription | null,
  indexName: string | null,
): string[] {
  if (!describe) return [];
  let schema = describe.key_schema;
  if (indexName !== null) {
    const gsi = describe.global_secondary_indexes.find(
      (g) => g.index_name === indexName,
    );
    const lsi = describe.local_secondary_indexes.find(
      (l) => l.index_name === indexName,
    );
    if (gsi) schema = gsi.key_schema;
    else if (lsi) schema = lsi.key_schema;
  }
  return schema.map((k) => k.attribute_name);
}

// ---------------------------------------------------------------------------
// DataViewRoot — registered renderer
// ---------------------------------------------------------------------------

function DataViewRoot({ tab, active }: { tab: Tab; active: boolean }) {
  if (!isPayload(tab.payload)) {
    return <div className={styles.invalid}>Invalid tab payload.</div>;
  }
  return <DataViewContent tab={tab} payload={tab.payload} active={active} />;
}

// ---------------------------------------------------------------------------
// DataViewContent — the actual tab body
// ---------------------------------------------------------------------------

interface DataViewContentProps {
  tab: Tab;
  payload: DynamoDataViewPayload;
  active: boolean;
}

function DataViewContent({ tab, payload, active }: DataViewContentProps) {
  const { connectionId, connectionName: _connName, tableName } = payload;
  const tabId = tab.id;

  // ── Connection params — for needs_credentials (task 16.2) ─────────────────
  // Read from the persisted connection list so the flag is available even when
  // the active-connection envelope (listActive) doesn't expose it.
  const { items: allConnections } = useConnections();

  const connParams = useMemo(() => {
    const conn = allConnections.find(
      (c) => c.id === connectionId && c.kind === DYNAMO_KIND,
    );
    return conn ? (conn.params as unknown as DynamoParams) : null;
  }, [allConnections, connectionId]);

  const needsCredentials = connParams?.needs_credentials === true;
  /** Whether the connection is read-only — used to gate all edit affordances. */
  const isReadOnly = connParams?.read_only === true;

  // ── Context folder path — §9.5/§9.6 DocsPanel + column notes ─────────────
  const contextPath = useMemo(
    () => allConnections.find((c) => c.id === connectionId)?.context_path ?? null,
    [allConnections, connectionId],
  );

  // ── QueryBuilder imperative ref (⌘F shortcut) ────────────────────────────
  const queryBuilderRef = useRef<FilterBarHandle>(null);

  // ── Toast ─────────────────────────────────────────────────────────────────
  const toast = useToast();

  // ── Edit-in-place state (task 6.3) ─────────────────────────────────────────
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [savingCell, setSavingCell] = useState<EditingCell | null>(null);

  // ── Insert modal state (task 8.8) ──────────────────────────────────────────
  const [insertModalOpen, setInsertModalOpen] = useState(false);

  // ── Delete modal state (task 9.3) ──────────────────────────────────────────
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);

  // ── Inspector editing state (task 9.2 guard) ──────────────────────────────
  const [inspectorIsEditing, setInspectorIsEditing] = useState(false);

  // ── Unsaved-draft guard (task 11.1) ────────────────────────────────────────
  const {
    hasUnsavedDraft,
    setInlineCellDirty,
    setInspectorDirty,
    setInsertModalDirty,
  } = useUnsavedDraft();

  // Track inline cell dirty state — any open editor is considered dirty.
  useEffect(() => {
    setInlineCellDirty(editingCell !== null);
  // setInlineCellDirty is stable (from useCallback in useUnsavedDraft)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingCell]);

  // ── Discard dialog state — guards for close / switch / row-change / refresh ─
  type DiscardReason = "tab-close" | "tab-switch" | "row-change" | "refresh";
  const [discardDialog, setDiscardDialog] = useState<{
    reason: DiscardReason;
    context: string;
    onConfirm: () => void;
  } | null>(null);

  // Keep stable resolve callbacks for the close/switch guards.
  const pendingCloseResolveRef = useRef<((ok: boolean) => void) | null>(null);
  const pendingSwitchResolveRef = useRef<((ok: boolean) => void) | null>(null);

  // ── Tab-close guard (task 11.2) ────────────────────────────────────────────
  useCloseConfirm(
    tabId,
    useCallback(async () => {
      if (!hasUnsavedDraft) return true;
      // Surface the dialog and suspend the close until the user responds.
      return new Promise<boolean>((resolve) => {
        pendingCloseResolveRef.current = resolve;
        setDiscardDialog({
          reason: "tab-close",
          context: "close the tab",
          onConfirm: () => {
            resolve(true);
            pendingCloseResolveRef.current = null;
            setDiscardDialog(null);
          },
        });
      });
    }, [hasUnsavedDraft]),
  );

  // ── Tab-switch (activate) guard (task 11.2) ────────────────────────────────
  useActivateConfirm(
    tabId,
    useCallback(async () => {
      if (!hasUnsavedDraft) return true;
      return new Promise<boolean>((resolve) => {
        pendingSwitchResolveRef.current = resolve;
        setDiscardDialog({
          reason: "tab-switch",
          context: "switch tabs",
          onConfirm: () => {
            resolve(true);
            pendingSwitchResolveRef.current = null;
            setDiscardDialog(null);
          },
        });
      });
    }, [hasUnsavedDraft]),
  );

  // ── Row-change guard when inspector is editing (task 11.2) ─────────────────
  // The pending selection is captured in the dialog's onConfirm closure, so we
  // only need a flag to clear in the cancel path. Use a ref to avoid re-renders.
  const pendingRowSelectRef = useRef<{
    rowIndex: number;
    attribute?: string;
    gesture?: SelectGesture;
  } | null>(null);

  // ── Credential-refresh bypass (task 11.3) ─────────────────────────────────
  // When `dynamo:credentials-refreshed:ui` fires, drafts are preserved silently.
  // The guard is only triggered on user actions (tab close, tab switch, row
  // select) — not on background events — so no explicit suppression is needed.
  // In-flight saves retry automatically via the existing `useDynamoItems`
  // retry handler; this listener is a no-op placeholder for documentation.
  useEffect(() => {
    function onCredentialsRefreshed(e: Event) {
      const detail = (e as CustomEvent<{ id?: string }>).detail;
      if (detail?.id !== connectionId) return;
      // NOTE: Retries for in-flight saves happen in useDynamoItems.
      // Drafts are NOT cleared here — they persist silently per spec §11.
    }
    window.addEventListener("dynamo:credentials-refreshed:ui", onCredentialsRefreshed);
    return () => window.removeEventListener("dynamo:credentials-refreshed:ui", onCredentialsRefreshed);
  }, [connectionId]);

  // ── Describe state ─────────────────────────────────────────────────────────
  const [describe, setDescribe] = useState<TableDescription | null>(
    payload.describe,
  );
  const [describeLoading, setDescribeLoading] = useState(false);
  const [describeError, setDescribeError] = useState<string | null>(null);

  // Fetch describe on mount if not provided in the payload.
  const hasFetchedDescribe = useRef(false);
  useEffect(() => {
    if (hasFetchedDescribe.current) return;
    hasFetchedDescribe.current = true;
    if (payload.describe === null) {
      setDescribeLoading(true);
      dynamoTablesApi
        .describeTable({ connectionId, tableName, origin: "auto" })
        .then((val) => {
          setDescribe(val);
          setDescribeLoading(false);
        })
        .catch((e: unknown) => {
          const msg =
            e && typeof e === "object" && "message" in e
              ? String((e as { message: unknown }).message)
              : "Failed to load metadata";
          setDescribeError(msg);
          setDescribeLoading(false);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Settings — view mode (tabla/json) ──────────────────────────────────────
  const viewModeKey = `dynamoView:${connectionId}:${tableName}`;
  const [viewMode, setViewMode] = useSetting<ViewMode>(viewModeKey, "tabla");

  // ── Settings — page size ──────────────────────────────────────────────────
  const pageSizeKey = `dynamoLimit:${connectionId}:${tableName}`;
  const [pageSize, setPageSize] = useSetting<number>(pageSizeKey, 100);

  // ── Sort state — client-side column sort (#58) ────────────────────────────
  const { sorting, setSorting } = useDynamoSort(connectionId, tableName);

  // ── Settings — version attribute for optimistic locking (task 10.1) ───────
  const versionAttrKey = `dynamoVersionAttr:${connectionId}:${tableName}`;
  const [versionAttr, setVersionAttr] = useSetting<string>(versionAttrKey, "");

  // ── Optimistic locking — session state (task 10.3) ────────────────────────
  const [useConditionExpression, setUseConditionExpression] = useState(false);
  const [lockingDialogOpen, setLockingDialogOpen] = useState(false);

  // ── Table models (STD detection — D2 / D8) ────────────────────────────────
  // Loads dynamo_model docs for this table from the context folder.
  // `isStd` is true when at least one model doc exists.
  const { models, isStd, applyOptimisticSave, applyOptimisticDelete } = useTableModels(
    connectionId,
    tableName,
    contextPath,
  );

  // ── Model editor state (task 4.6) ──────────────────────────────────────────
  const [editorState, setEditorState] = useState<{ open: boolean; initial: DynamoModel | null }>({
    open: false,
    initial: null,
  });
  const [linkPromptOpen, setLinkPromptOpen] = useState(false);
  const [savingModel, setSavingModel] = useState(false);

  const handleNewModel = useCallback(() => {
    if (!contextPath) {
      setLinkPromptOpen(true);
    } else {
      setEditorState({ open: true, initial: null });
    }
  }, [contextPath]);

  const handleEditModel = useCallback(
    (entityName: string) => {
      if (!contextPath) {
        setLinkPromptOpen(true);
        return;
      }
      const model = models.find((m) => m.name === entityName) ?? null;
      setEditorState({ open: true, initial: model });
    },
    [contextPath, models],
  );

  const handleSaveModel = useCallback(
    async (draft: ModelDraft, opts: { isEdit: boolean; previousName?: string }) => {
      setSavingModel(true);
      try {
        await saveModel(connectionId, tableName, draft);
        applyOptimisticSave({
          name: draft.name,
          physical_table: tableName,
          access_patterns: draft.access_patterns,
          body: draft.body,
        });
        // Rename: if the name changed, delete the old model doc too.
        if (opts.isEdit && opts.previousName && opts.previousName !== draft.name) {
          await deleteModel(connectionId, tableName, opts.previousName);
          applyOptimisticDelete(opts.previousName);
        }
        setEditorState({ open: false, initial: null });
        toast.show("Model saved", "success");
      } catch (e) {
        const msg = (e as { message?: string }).message ?? "Save failed";
        toast.show(msg, "error");
      } finally {
        setSavingModel(false);
      }
    },
    [connectionId, tableName, applyOptimisticSave, applyOptimisticDelete, toast],
  );

  // ── AI Inspector — capability gating ──────────────────────────────────────
  const activeProvider = useResolvedProviderId(connectionId);
  const { providers } = useAiSettings();
  const canInspect = !!providers.find((p) => p.id === activeProvider)?.capabilities.can_read_files;
  const inspectDisabledReason = canInspect
    ? undefined
    : "Switch to a CLI provider (Claude Code or Codex) to generate models with AI — API providers can't read your repo.";

  // ── AI Inspector — hook + open state ──────────────────────────────────────
  const inspector = useModelInspector(connectionId, tableName);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  const handleInspectModels = useCallback(async () => {
    if (!contextPath) {
      setLinkPromptOpen(true);
      return;
    }
    const src = await getProjectSource(connectionId);
    if (!src) {
      const picked = await dialogOpen({
        directory: true,
        multiple: false,
        title: "Select your application source repo",
      });
      if (typeof picked !== "string") return;
      await setProjectSource(connectionId, picked);
    }
    inspector.reset();
    setInspectorOpen(true);
    await inspector.start();
  }, [contextPath, connectionId, inspector]);

  const handleAcceptProposal = useCallback(
    async (draft: ModelDraft) => {
      await handleSaveModel(draft, { isEdit: false });
      inspector.removeProposal(draft.name);
    },
    [handleSaveModel, inspector],
  );

  const handleEditProposal = useCallback(
    (model: import("./types").InspectedModel) => {
      setEditorState({
        open: true,
        initial: {
          name: model.name,
          physical_table: tableName,
          access_patterns: model.access_patterns,
          body: model.body ?? undefined,
        },
      });
    },
    [tableName],
  );

  const handleDeleteModel = useCallback(
    async (name: string) => {
      try {
        await deleteModel(connectionId, tableName, name);
        applyOptimisticDelete(name);
        setEditorState({ open: false, initial: null });
        toast.show("Model deleted", "success");
      } catch (e) {
        const msg = (e as { message?: string }).message ?? "Delete failed";
        toast.show(msg, "error");
      }
    },
    [connectionId, tableName, applyOptimisticDelete, toast],
  );

  // ── Builder state ──────────────────────────────────────────────────────────
  const [builder, setBuilder] = useState<BuilderState>(() => ({
    mode: "scan",
    indexName: null,
    pageSize,
    consistentRead: false,
    scanIndexForward: true,
    filters: [],
  }));

  // ── D10 live fallback: when isStd flips false while in model mode, ─────────
  // switch back to raw, preserving the last compiled query.
  const prevIsStdRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevIsStdRef.current === null) {
      prevIsStdRef.current = isStd;
      return;
    }
    const wasStd = prevIsStdRef.current;
    prevIsStdRef.current = isStd;
    if (wasStd && !isStd) {
      // Table just lost its model docs — force raw mode
      setBuilder((prev) => {
        if (prev.builderMode !== "model") return prev;
        return { ...prev, builderMode: "raw" };
      });
    }
  }, [isStd]);

  // ── Builder validity (used to disable Run in Toolbar) ─────────────────────
  // Scan mode is always valid; Query mode becomes invalid until PK is filled.
  const [builderValid, setBuilderValid] = useState(true);
  const [builderInvalidReason, setBuilderInvalidReason] = useState<string | undefined>();

  const handleValidityChange = useCallback((isValid: boolean, reason?: string) => {
    setBuilderValid(isValid);
    setBuilderInvalidReason(isValid ? undefined : reason);
  }, []);

  // Keep builder.pageSize in sync when the persisted setting loads.
  useEffect(() => {
    setBuilder((prev) => ({ ...prev, pageSize }));
  }, [pageSize]);

  // ── Inspector width ────────────────────────────────────────────────────────
  const { width: inspectorWidth, setWidth: setInspectorWidth, min: inspMin } =
    useDynamoInspectorWidth(connectionId, tableName);

  // ── Inspector selection — multi-row (task 9.1) ────────────────────────────
  // selectedRowIndices: set of all selected row indices
  // primarySelectedRowIndex: the most recently clicked row (for inspector)
  // anchorRowIndex: the anchor for shift-click range selection
  const [selectedRowIndices, setSelectedRowIndices] = useState<Set<number>>(new Set());
  const [primarySelectedRowIndex, setPrimarySelectedRowIndex] = useState<number | null>(null);
  const anchorRowIndexRef = useRef<number | null>(null);
  const [_selectedAttribute, setSelectedAttribute] = useState<string | undefined>(undefined);

  // ── applyRowSelect: the real selection logic, called after guard passes ─────
  const applyRowSelect = useCallback(
    (rowIndex: number, attribute?: string, gesture?: SelectGesture) => {
      setSelectedAttribute(attribute);

      if (gesture?.shiftKey && anchorRowIndexRef.current !== null) {
        // Range select from anchor to clicked row
        const anchor = anchorRowIndexRef.current;
        const lo = Math.min(anchor, rowIndex);
        const hi = Math.max(anchor, rowIndex);
        const range = new Set<number>();
        for (let i = lo; i <= hi; i++) range.add(i);
        setSelectedRowIndices(range);
        setPrimarySelectedRowIndex(rowIndex);
        // Do NOT update anchor on shift-click
      } else if (gesture?.metaKey) {
        // Toggle this row in the selection
        setSelectedRowIndices((prev) => {
          const next = new Set(prev);
          if (next.has(rowIndex)) {
            next.delete(rowIndex);
          } else {
            next.add(rowIndex);
          }
          return next;
        });
        setPrimarySelectedRowIndex(rowIndex);
        anchorRowIndexRef.current = rowIndex;
      } else {
        // Plain click — replace selection with just this row
        setSelectedRowIndices(new Set([rowIndex]));
        setPrimarySelectedRowIndex(rowIndex);
        anchorRowIndexRef.current = rowIndex;
      }
    },
    [],
  );

  const handleSelectRow = useCallback(
    (rowIndex: number, attribute?: string, gesture?: SelectGesture) => {
      // ── Row-change guard (task 11.2) ───────────────────────────────────────
      // When the inspector JSON editor has a dirty draft AND the user clicks a
      // different row, prompt "Discard changes?" before changing the selection.
      if (
        inspectorIsEditing &&
        rowIndex !== primarySelectedRowIndex
      ) {
        pendingRowSelectRef.current = { rowIndex, attribute, gesture };
        setDiscardDialog({
          reason: "row-change",
          context: "select a different row",
          onConfirm: () => {
            applyRowSelect(rowIndex, attribute, gesture);
            pendingRowSelectRef.current = null;
            setDiscardDialog(null);
            // Clear inspector dirty state after discard
            setInspectorDirty(false);
          },
        });
        return;
      }
      applyRowSelect(rowIndex, attribute, gesture);
    },
    [inspectorIsEditing, primarySelectedRowIndex, applyRowSelect, setInspectorDirty],
  );

  // Derived: primary selected row index (for inspector)
  const selectedRowIndex = primarySelectedRowIndex;

  // ── Count state — owned by useCount (task 13.1–13.3) ────────────────────
  const {
    countLoading,
    countResult,
    triggerCount,
    clearCount,
  } = useCount(connectionId, tableName, builder, describe);

  // ── useDynamoItems ─────────────────────────────────────────────────────────
  // Hook requires a non-null describe. We defer the hook's actual invocation
  // by using a dummy describe until the real one loads. The hook is always
  // mounted (Rules of Hooks) but won't be called by the user until describe is
  // available (run button is only accessible once the tab is visible).
  const DUMMY_DESCRIBE: TableDescription = {
    table_name: tableName,
    table_arn: "",
    table_status: "ACTIVE",
    item_count: 0,
    table_size_bytes: 0,
    billing_mode: "PAY_PER_REQUEST",
    key_schema: [],
    attribute_definitions: [],
    global_secondary_indexes: [],
    local_secondary_indexes: [],
  };

  const {
    items,
    lastEvaluatedKey,
    count,
    status,
    error,
    run,
    runWithOverride,
    loadMore,
    triggerAutoLoadMore,
    reset,
    autoScrollDisabled,
    replaceItem,
    removeItems,
  } = useDynamoItems({
    connectionId,
    tableName,
    builder,
    describe: describe ?? DUMMY_DESCRIBE,
  });

  // Derived: selected item for the inspector (items only grows, index stable)
  const selectedItem: AttributeMap | null =
    selectedRowIndex !== null ? (items[selectedRowIndex] ?? null) : null;

  // ── handleCommitCell (task 6.3) ────────────────────────────────────────────
  // Fires dynamo.update_item with the row's key and the new value.
  // Placed after useDynamoItems so it has access to `items` and `replaceItem`.
  const handleCommitCell = useCallback(
    async (rowIndex: number, attrName: string, nextValue: AttributeValue) => {
      const row = items[rowIndex];
      if (!row) return;

      const keyNames = resolveKeyNamesForEdit(describe, builder.indexName);
      const key: AttributeMap = {};
      for (const k of keyNames) {
        if (!row[k]) {
          toast.show(`Row is missing key attribute "${k}"`, "error");
          setEditingCell(null);
          return;
        }
        key[k] = row[k]!;
      }

      // ── Optimistic locking condition (task 10.5) ──────────────────────────
      let conditionExpression: string | null = null;
      let conditionNames: Record<string, string> | null = null;
      let conditionValues: import("./types").AttributeMap | null = null;

      if (useConditionExpression && versionAttr) {
        const pkAttr = describe?.key_schema?.[0]?.attribute_name ?? "";
        const prevValue = row[versionAttr];
        const locking = buildLockingCondition(versionAttr, prevValue, pkAttr);
        if (locking) {
          conditionExpression = locking.condition_expression;
          conditionNames = locking.expression_attribute_names;
          conditionValues = locking.expression_attribute_values;
        }
      }

      setSavingCell({ rowIndex, attrName });
      try {
        const resp = await dynamoUpdateItem(connectionId, tableName, {
          key,
          updates: { set: { [attrName]: nextValue }, remove: [] },
          condition_expression: conditionExpression,
          expression_attribute_names: conditionNames,
          expression_attribute_values: conditionValues,
          return_values: "ALL_NEW",
        });
        // Update local item from response attributes.
        if (resp.attributes) {
          replaceItem(rowIndex, resp.attributes);
        }
      } catch (e) {
        const err = e as { message?: string };
        const msg = err?.message ?? "Update failed";
        toast.show(msg, "error");
        // Revert is automatic — we never wrote optimistically.
      } finally {
        setSavingCell(null);
        setEditingCell(null);
      }
    },
    // deps: stable refs via useCallback; items/describe/builder read via closure
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, describe, builder.indexName, connectionId, tableName, replaceItem, toast, useConditionExpression, versionAttr],
  );

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleRun = useCallback(() => {
    void run("user");
  }, [run]);

  const handleReset = useCallback(() => {
    setBuilder({
      mode: "scan",
      indexName: null,
      pageSize,
      consistentRead: false,
      scanIndexForward: true,
      filters: [],
    });
    reset();
    clearCount();
    // Reset selection when items are wiped.
    setPrimarySelectedRowIndex(null);
    setSelectedRowIndices(new Set());
    anchorRowIndexRef.current = null;
  }, [reset, pageSize, clearCount]);

  // ── resetDrafts — exit all edit modes and clear dirty flags ──────────────
  // Called on confirmed discard before a refresh so hasUnsavedDraft becomes
  // false and the inline/inspector editors are no longer open.
  const resetDrafts = useCallback(() => {
    setEditingCell(null);         // cancels the inline cell editor
    setInspectorIsEditing(false); // exits the inspector JSON editor
    setInspectorDirty(false);
    setInlineCellDirty(false);
    setInsertModalDirty(false);
  }, [setInspectorDirty, setInlineCellDirty, setInsertModalDirty]);

  // ── guardedRefresh — prompts "Discard changes?" when a draft exists ────────
  // Wraps an arbitrary refresh action (handleRun or handleReset). When no draft
  // exists it calls doRefresh immediately with no dialog.
  const guardedRefresh = useCallback(
    (doRefresh: () => void) => {
      if (!hasUnsavedDraft) {
        doRefresh();
        return;
      }
      setDiscardDialog({
        reason: "refresh",
        context: "refresh the table",
        onConfirm: () => {
          resetDrafts();
          setDiscardDialog(null);
          doRefresh();
        },
      });
    },
    [hasUnsavedDraft, resetDrafts],
  );

  const handleLoadMore = useCallback(() => {
    void loadMore("user");
  }, [loadMore]);

  // Count is now fully owned by the useCount hook (task 13.1).
  // triggerCount has its own in-flight guard; we just pass it through.
  const handleCount = useCallback(() => {
    triggerCount();
  }, [triggerCount]);

  const handlePageSizeChange = useCallback(
    (next: number) => {
      setPageSize(next);
      setBuilder((prev) => ({ ...prev, pageSize: next }));
    },
    [setPageSize],
  );

  const handleBuilderChange = useCallback(
    (next: BuilderState) => {
      setBuilder(next);
      // Count auto-clear (task 13.3) is handled inside useCount via snapshot
      // comparison. No explicit clear needed here.
    },
    [],
  );

  // ── Resize handle for inspector ────────────────────────────────────────────

  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const handleHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startWidth: inspectorWidth };
      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        const delta = dragRef.current.startX - ev.clientX;
        setInspectorWidth(dragRef.current.startWidth + delta);
      };
      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [inspectorWidth, setInspectorWidth],
  );

  // ── Keyboard shortcuts — ⌘R / ⌘⇧R ─────────────────────────────────────────
  // Only fire when this tab is active, and NOT when focus is inside CodeMirror.
  // We use `whenInInput: true` so the shortcut fires from query-builder inputs.
  // The CodeMirror guard is an explicit check in the handler.

  useShortcuts(
    active
      ? [
          {
            key: "r",
            mod: true,
            shift: false,
            whenInInput: true,
            handler: () => {
              if (focusIsInCodeMirror()) return;
              guardedRefresh(handleRun);
            },
          },
          {
            key: "r",
            mod: true,
            shift: true,
            whenInInput: true,
            handler: () => {
              if (focusIsInCodeMirror()) return;
              guardedRefresh(handleReset);
            },
          },
          // ⌘N — open Insert modal (no-op on read-only or CodeMirror focus)
          {
            key: "n",
            mod: true,
            shift: false,
            whenInInput: true,
            handler: () => {
              if (isReadOnly) return;
              if (focusIsInCodeMirror()) return;
              setInsertModalOpen(true);
            },
          },
        ]
      : [],
  );

  // ── ⌘F / Ctrl+F — focus the QueryBuilder ──────────────────────────────────
  // Mirrors the pattern from the Postgres TableViewerTab's ⌘S/⌘1-3/⌘Z listener.
  // Gated on `active` so only the focused tab responds. Skips CodeMirror surfaces.
  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      if (!((e.metaKey || e.ctrlKey) && e.key === "f" && !e.shiftKey && !e.altKey)) return;
      const focused = document.activeElement as HTMLElement | null;
      if (focused?.closest(".cm-editor")) return;
      e.preventDefault();
      queryBuilderRef.current?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);

  // ── onApplyOnlyFilter — per-row Apply (Option B via runWithOverride) ────────
  // Receives a transient BuilderState (one filter row) from QueryBuilder and
  // dispatches it through useDynamoItems.runWithOverride() so the results panel
  // shows the single-filter result WITHOUT mutating the user's full builder.
  // QueryBuilder internally marks lastRunStateRef to that transient state so
  // the dirty pip reflects divergence from the user's full draft.
  const handleApplyOnlyFilter = useCallback(
    (transient: BuilderState) => {
      void runWithOverride(transient, "user");
    },
    [runWithOverride],
  );

  // ── Backspace handler — open delete modal (task 9.2) ──────────────────────
  // Guards (all must pass):
  //   - tab is active
  //   - not read-only
  //   - no inline cell editor open
  //   - inspector is not in edit mode
  //   - focus not in CodeMirror
  //   - focus not in a native text input/textarea/select/contentEditable
  //   - at least one row selected
  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Backspace" && e.key !== "Delete") return;
      if (isReadOnly) return;
      if (editingCell !== null) return;
      if (inspectorIsEditing) return;
      if (focusIsInCodeMirror()) return;
      const el = document.activeElement;
      if (el) {
        const tag = el.tagName.toUpperCase();
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if ((el as HTMLElement).isContentEditable) return;
      }
      if (selectedRowIndices.size === 0) return;
      e.preventDefault();
      setDeleteModalOpen(true);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, isReadOnly, editingCell, inspectorIsEditing, selectedRowIndices]);

  // ── deleteRows — derived from selectedRowIndices (task 9.3) ───────────────
  const deleteRows = useMemo<DeleteRow[]>(() => {
    const keyNames = resolveKeyNamesForEdit(describe, builder.indexName);
    return Array.from(selectedRowIndices)
      .sort((a, b) => a - b)
      .map((rowIndex) => {
        const item = items[rowIndex];
        if (!item) return null;
        const key: Record<string, import("./types").AttributeValue> = {};
        for (const k of keyNames) {
          if (item[k]) key[k] = item[k]!;
        }
        // Build human-readable label: pk=value, sk=value
        const label = Object.entries(key)
          .map(([k, v]) => {
            const val = "S" in v ? v.S : "N" in v ? v.N : "BOOL" in v ? String(v.BOOL) : "?";
            return `${k}=${val}`;
          })
          .join(", ");
        return { rowIndex, key, label };
      })
      .filter((r): r is DeleteRow => r !== null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRowIndices, items, describe, builder.indexName]);

  // ── Render ─────────────────────────────────────────────────────────────────

  // Show loading spinner while describe is being fetched on mount.
  if (describeLoading && describe === null) {
    return (
      <div className={styles.root}>
        <div className={styles.loadingDescribe}>
          <Loader2 size={14} className={styles.spinner} />
          Loading table metadata…
        </div>
      </div>
    );
  }

  const isMetadataMode = viewMode === "metadata";

  return (
    <div className={styles.root}>
      <Toolbar
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        builder={builder}
        onBuilderChange={handleBuilderChange}
        status={status}
        lastEvaluatedKey={lastEvaluatedKey}
        onRun={() => guardedRefresh(handleRun)}
        onReset={() => guardedRefresh(handleReset)}
        onLoadMore={handleLoadMore}
        countLoading={countLoading}
        countResult={countResult}
        onCount={handleCount}
        needsCredentials={needsCredentials}
        pageSize={pageSize}
        onPageSizeChange={handlePageSizeChange}
        runDisabled={!builderValid}
        runDisabledReason={builderInvalidReason}
        isReadOnly={isReadOnly}
        onInsert={!isReadOnly ? () => setInsertModalOpen(true) : undefined}
        useConditionExpression={useConditionExpression}
        onUseConditionExpressionChange={!isReadOnly ? setUseConditionExpression : undefined}
        onOpenLockingDialog={!isReadOnly ? () => setLockingDialogOpen(true) : undefined}
      />

      {describeError && (
        <div
          style={{
            padding: "8px 14px",
            fontSize: 11,
            color: "var(--danger)",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            gap: 8,
            alignItems: "center",
          }}
        >
          Failed to load metadata: {describeError}
          <button
            type="button"
            style={{
              padding: "2px 7px",
              border: "1px solid var(--border-strong)",
              borderRadius: 3,
              background: "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 11,
              fontFamily: "inherit",
            }}
            onClick={() => {
              setDescribeLoading(true);
              setDescribeError(null);
              dynamoTablesApi
                .describeTable({ connectionId, tableName, origin: "user" })
                .then((val) => {
                  setDescribe(val);
                  setDescribeLoading(false);
                })
                .catch((e: unknown) => {
                  const msg =
                    e && typeof e === "object" && "message" in e
                      ? String((e as { message: unknown }).message)
                      : "Failed to load metadata";
                  setDescribeError(msg);
                  setDescribeLoading(false);
                });
            }}
          >
            Retry
          </button>
        </div>
      )}

      {isMetadataMode ? (
        <MetadataView
          connectionId={connectionId}
          tableName={tableName}
          initialDescribe={describe}
          describe={describe}
          onDescribeUpdated={setDescribe}
        />
      ) : (
        <div className={styles.body}>
          <div className={styles.mainArea}>
            {/* QueryBuilder */}
            {describe && (
              <QueryBuilder
                ref={queryBuilderRef}
                builder={builder}
                describe={describe}
                onBuilderChange={handleBuilderChange}
                onValidityChange={handleValidityChange}
                onRun={() => guardedRefresh(handleRun)}
                onReset={() => guardedRefresh(handleReset)}
                onApplyOnlyFilter={handleApplyOnlyFilter}
                disabled={needsCredentials}
                models={models}
                isStd={isStd}
                canEditModels={true}
                onNewModel={handleNewModel}
                onEditModel={handleEditModel}
                onInspectModels={() => { void handleInspectModels(); }}
                canInspect={canInspect}
                inspectDisabledReason={inspectDisabledReason}
              />
            )}

            {/* Results panel — Tabla view / JSON view */}
            {viewMode === "tabla" ? (
              <TabView
                items={items}
                describe={describe}
                indexName={builder.indexName}
                connectionId={connectionId}
                tableName={tableName}
                selectedRowIndices={selectedRowIndices}
                primarySelectedRowIndex={primarySelectedRowIndex}
                onSelect={handleSelectRow}
                onLoadMore={triggerAutoLoadMore}
                hasMore={lastEvaluatedKey !== null}
                status={status}
                autoScrollDisabled={autoScrollDisabled}
                editingCell={editingCell}
                onStartEdit={(rowIndex, attrName) =>
                  setEditingCell({ rowIndex, attrName })
                }
                onCommitEdit={(rowIndex, attrName, next) => {
                  void handleCommitCell(rowIndex, attrName, next);
                }}
                onCancelEdit={() => setEditingCell(null)}
                savingCell={savingCell}
                isReadOnly={isReadOnly}
                sorting={sorting}
                onSortingChange={setSorting}
              />
            ) : (
              <JsonView
                items={items}
                selectedRowIndex={selectedRowIndex}
                onSelect={(rowIndex) => handleSelectRow(rowIndex)}
                onLoadMore={triggerAutoLoadMore}
                hasMore={lastEvaluatedKey !== null}
                status={status}
                autoScrollDisabled={autoScrollDisabled}
                describe={describe}
                indexName={builder.indexName}
              />
            )}
          </div>

          {/* Inspector dock */}
          {inspectorWidth > inspMin && (
            <>
              <div
                className={styles.handle}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize inspector"
                onMouseDown={handleHandleMouseDown}
              />
              <div
                className={styles.inspectorDock}
                style={{ width: inspectorWidth }}
              >
                <Inspector
                  item={selectedItem}
                  describe={describe}
                  indexName={builder.indexName}
                  onClearSelection={() => {
                    setPrimarySelectedRowIndex(null);
                    setSelectedRowIndices(new Set());
                    anchorRowIndexRef.current = null;
                  }}
                  isReadOnly={isReadOnly}
                  connectionId={connectionId}
                  tableName={tableName}
                  rowIndex={selectedRowIndex ?? undefined}
                  onPatchItem={replaceItem}
                  onEditingChange={setInspectorIsEditing}
                  onDirtyChange={setInspectorDirty}
                  locking={!isReadOnly ? {
                    versionAttr,
                    enabled: useConditionExpression,
                    pkAttr: describe?.key_schema?.[0]?.attribute_name ?? "",
                  } : undefined}
                  contextPath={contextPath}
                />
              </div>
            </>
          )}
        </div>
      )}

      <BottomBar
        itemsLoaded={count}
        status={status}
        error={error}
        countResult={countResult}
      />

      {/* Insert modal — task 8.8 */}
      {describe && (
        <InsertModal
          open={insertModalOpen}
          describe={describe}
          indexName={builder.indexName}
          connectionId={connectionId}
          tableName={tableName}
          onClose={() => {
            setInsertModalOpen(false);
            setInsertModalDirty(false);
          }}
          onSuccess={() => {
            setInsertModalDirty(false);
            handleRun();
          }}
          onDirtyChange={setInsertModalDirty}
        />
      )}

      {/* Delete confirmation modal — task 9.3 */}
      {deleteModalOpen && deleteRows.length > 0 && (
        <DeleteConfirmationModal
          open={deleteModalOpen}
          rows={deleteRows}
          connectionId={connectionId}
          tableName={tableName}
          onClose={() => {
            setDeleteModalOpen(false);
          }}
          onComplete={(deletedIndices) => {
            // Remove successfully deleted rows from local state (task 9.4)
            removeItems(deletedIndices);
            // Clear selection of deleted rows; keep any remaining failures selected
            setSelectedRowIndices((prev) => {
              const next = new Set(prev);
              for (const idx of deletedIndices) {
                next.delete(idx);
              }
              return next;
            });
            if (deletedIndices.includes(primarySelectedRowIndex ?? -1)) {
              setPrimarySelectedRowIndex(null);
            }
            anchorRowIndexRef.current = null;
          }}
        />
      )}

      {/* Optimistic locking config dialog — task 10.2 */}
      <OptimisticLockingDialog
        open={lockingDialogOpen}
        versionAttr={versionAttr}
        onChange={setVersionAttr}
        onClose={() => setLockingDialogOpen(false)}
      />

      {/* Model editor — task 4.6 */}
      <ModelEditor
        open={editorState.open}
        describe={describe}
        initial={editorState.initial}
        existingNames={models
          .map((m) => m.name)
          .filter((n) => n !== editorState.initial?.name)}
        onClose={() => setEditorState({ open: false, initial: null })}
        onSave={(draft, opts) => void handleSaveModel(draft, opts)}
        onDelete={(name) => void handleDeleteModel(name)}
        saving={savingModel}
      />

      {/* Link folder prompt — task 4.5 */}
      <LinkFolderPrompt
        open={linkPromptOpen}
        connectionId={connectionId}
        onClose={() => setLinkPromptOpen(false)}
        onLinked={() => {
          setLinkPromptOpen(false);
          setEditorState({ open: true, initial: null });
        }}
      />

      {/* AI Inspector Review */}
      <InspectorReview
        open={inspectorOpen}
        describe={describe}
        status={inspector.status}
        statusMessage={inspector.statusMessage}
        proposals={inspector.proposals}
        error={inspector.error}
        existingNames={models.map((m) => m.name)}
        saving={savingModel}
        onClose={() => setInspectorOpen(false)}
        onEdit={handleEditProposal}
        onAccept={(draft) => void handleAcceptProposal(draft)}
        onDiscard={inspector.removeProposal}
      />

      {/* Unsaved-draft guard dialog — task 11.2 */}
      {discardDialog && (
        <DiscardChangesDialog
          context={discardDialog.context}
          onDiscard={discardDialog.onConfirm}
          onCancel={() => {
            // Resolve any pending promise with false (cancel the navigation).
            if (discardDialog.reason === "tab-close") {
              pendingCloseResolveRef.current?.(false);
              pendingCloseResolveRef.current = null;
            } else if (discardDialog.reason === "tab-switch") {
              pendingSwitchResolveRef.current?.(false);
              pendingSwitchResolveRef.current = null;
            } else if (discardDialog.reason === "row-change") {
              pendingRowSelectRef.current = null;
            }
            // "refresh" has no suspended promise — just close the dialog.
            setDiscardDialog(null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper: open data view tab
// ---------------------------------------------------------------------------

import type { useTabs } from "@/platform/shell/tabs";

export function openDataViewTab(
  tabs: ReturnType<typeof useTabs>,
  opts: {
    connectionId: string;
    connectionName: string;
    tableName: string;
    describe: TableDescription | null;
  },
): string {
  const { connectionId, connectionName, tableName, describe } = opts;

  const payload: DynamoDataViewPayload = {
    connectionId,
    connectionName,
    tableName,
    describe,
  };

  return tabs.open({
    id: `dynamotbl:${connectionId}:${tableName}`,
    kind: DYNAMO_DATA_VIEW_KIND,
    title: tableName,
    payload,
    closable: true,
  });
}

// ---------------------------------------------------------------------------
// Side-effect: register tab kind with TabRegistry at module import time.
// The "dynamo-table-placeholder" kind was retired in Phase 9 (task 14.2);
// persisted records are migrated via migratePlaceholderTabs in migrateTabKinds.ts.
// ---------------------------------------------------------------------------

TabRegistry.register(DYNAMO_DATA_VIEW_KIND, DataViewRoot);
