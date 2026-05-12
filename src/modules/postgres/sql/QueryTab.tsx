import { useCallback, useEffect, useRef, useState } from "react";
import { Lock, Save, Wand2 } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { TabRegistry } from "@/platform/shell/tabs/TabRegistry";
import type { Tab } from "@/platform/shell/tabs/types";
import { useTabs } from "@/platform/shell/tabs/TabsContext";
import { getSetting, setSetting } from "@/platform/settings/api";
import { useToast } from "@/platform/toast";
import { useActiveConnections } from "../useActiveConnections";
import { globalSchemaCache } from "../schema/globalSchemaCache";
import { QueryEditor, type QueryEditorHandle } from "./QueryEditor";
import { ResultPanel } from "./ResultPanel";
import { ExportMenu } from "./export/ExportMenu";
import { RunSummary } from "./RunSummary";
import { useQueryBuffer } from "./useQueryBuffer";
import { useQueryRun } from "./useQueryRun";
import { useQueryTabState, isDirty } from "./useQueryTabState";
import { ConnectionSelector } from "./ConnectionSelector";
import { useCloseConfirm } from "@/platform/shell/tabs/useCloseConfirm";
import { savedQueriesStore } from "@/modules/saved-queries/store";
import { SaveAsModal } from "@/modules/saved-queries/SaveAsModal";
import dialogStyles from "@/platform/shell/Dialog.module.css";
import styles from "./QueryTab.module.css";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const FORMAT_HINT = isMac ? "⌘⇧F" : "Ctrl+Shift+F";
const SAVE_HINT = isMac ? "⌘S" : "Ctrl+S";

/** Debounce window for autocomplete reconfigures triggered by cache updates. */
const RECONFIGURE_DEBOUNCE_MS = 100;

/** Debounce for persisting last_connection_id on connection change. */
const PERSIST_CONN_DEBOUNCE_MS = 1000;

export const POSTGRES_QUERY_KIND = "postgres-query";

/**
 * Tab payload for a `postgres-query` tab.
 *
 * `initialConnectionId` and `initialConnectionName` seed the per-tab runtime
 * state on first mount. The *current* connection is held in `useQueryTabState`
 * and may change during the tab's lifetime.
 *
 * The `connectionId` MUST NOT be read from the tab id — the id format is now
 * `pgquery:<uuid>` with no embedded connection information.
 */
export interface PostgresQueryPayload {
  /** Connection to pre-select in the toolbar selector. Undefined = no preselection. */
  initialConnectionId?: string;
  initialConnectionName?: string;
  /** SQL to populate the editor on first open (before the buffer is loaded). */
  initialSql: string;
  /**
   * When set, this tab is bound to a saved query. Used by `openQueryTab` to
   * detect an already-open tab and focus it instead of creating a new one.
   * The authoritative runtime copy lives in `useQueryTabState`.
   */
  savedQueryId?: string;
}

function isPayload(v: unknown): v is PostgresQueryPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  // `initialSql` is required; the rest are optional.
  return typeof o.initialSql === "string";
}

function QueryTabRoot({ tab }: { tab: Tab }) {
  if (!isPayload(tab.payload)) {
    return <div className={styles.invalid}>Invalid query tab payload.</div>;
  }
  return (
    <QueryTab tabId={tab.id} payload={tab.payload} />
  );
}

interface InnerProps {
  tabId: string;
  payload: PostgresQueryPayload;
}

function QueryTab({ tabId, payload }: InnerProps) {
  const { getActive } = useActiveConnections();
  const toast = useToast();
  const { setTabTitle, setTabDirty } = useTabs();

  // Per-tab runtime state.
  const { state: tabState, actions: tabActions } = useQueryTabState({
    initialConnectionId: payload.initialConnectionId,
    initialConnectionName: payload.initialConnectionName,
    savedQueryId: payload.savedQueryId,
  });

  const isReadOnly =
    tabState.currentConnectionId != null
      ? (getActive(tabState.currentConnectionId)?.read_only ?? false)
      : false;

  const buffer = useQueryBuffer(tabId, payload.initialSql);
  const editorRef = useRef<QueryEditorHandle | null>(null);

  // runner no longer receives a static connectionId — it receives it
  // dynamically from tabState at the time of invocation.
  const runner = useQueryRun();

  // ---------------------------------------------------------------------------
  // Track current SQL for dirty-state computation.
  // The editor is authoritative for its text. We mirror the current value via
  // a ref so we can compute dirty state in callbacks without re-rendering.
  // ---------------------------------------------------------------------------
  const currentSqlRef = useRef<string>(buffer.initialSql);

  // We also keep a React state version so that dirty can drive UI re-renders.
  const [currentSqlForDirty, setCurrentSqlForDirty] = useState(buffer.initialSql);

  // Update when buffer loads.
  useEffect(() => {
    if (buffer.loaded) {
      currentSqlRef.current = buffer.initialSql;
      setCurrentSqlForDirty(buffer.initialSql);
    }
  }, [buffer.loaded, buffer.initialSql]);

  // ---------------------------------------------------------------------------
  // Dirty state — drives the ● in TabStrip.
  // Recomputed whenever tabState or currentSql changes.
  // ---------------------------------------------------------------------------
  const dirty = isDirty(tabState, currentSqlForDirty);

  useEffect(() => {
    setTabDirty(tabId, dirty);
  }, [tabId, dirty, setTabDirty]);

  // ---------------------------------------------------------------------------
  // Subscribe to the schema cache and re-bind the editor's autocomplete
  // sources whenever the namespace shape changes. Debounced so a burst of
  // cache writes (e.g., bulk fetch landing) only triggers one reconfigure.
  // Uses `currentConnectionId` from runtime state (not the payload).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const connId = tabState.currentConnectionId;
    if (!connId) return;
    let timer: number | null = null;
    let lastShape = globalSchemaCache.namespaceShapeKey(connId);
    const unsubscribe = globalSchemaCache.subscribe(() => {
      const shape = globalSchemaCache.namespaceShapeKey(connId);
      if (shape === lastShape) return;
      lastShape = shape;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        editorRef.current?.reconfigureAutocomplete();
      }, RECONFIGURE_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [tabState.currentConnectionId]);

  // ---------------------------------------------------------------------------
  // Connection selector handler (task 6.3 - 6.6)
  // ---------------------------------------------------------------------------
  const persistConnTimer = useRef<number | null>(null);

  const handleConnectionSelect = useCallback(
    (id: string, name: string) => {
      // 6.3: Update tab state.
      tabActions.setCurrentConnection(id, name);
      // 6.5: Reset runner.
      runner.reset();
      // 6.4: Autocomplete reconfigure will fire automatically via the
      // schema-cache effect above when currentConnectionId changes.
      // But we also trigger immediately so there's no delay on explicit switch.
      // The useEffect with [tabState.currentConnectionId] handles the schema-
      // cache subscription; we trigger reconfigure directly here too.
      setTimeout(() => {
        editorRef.current?.reconfigureAutocomplete();
      }, 0);

      // 6.6: Debounce persist last_connection_id for saved queries.
      if (tabState.savedQueryId) {
        if (persistConnTimer.current !== null) window.clearTimeout(persistConnTimer.current);
        const savedId = tabState.savedQueryId;
        persistConnTimer.current = window.setTimeout(() => {
          savedQueriesStore.updateQuery(savedId, { last_connection_id: id }).catch((e) => {
            console.warn("[argus.sql] persist last_connection_id:", e);
          });
        }, PERSIST_CONN_DEBOUNCE_MS);
      }
    },
    [tabActions, runner, tabState.savedQueryId],
  );

  // Cleanup persist timer on unmount.
  useEffect(() => {
    return () => {
      if (persistConnTimer.current !== null) window.clearTimeout(persistConnTimer.current);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Run handlers
  // ---------------------------------------------------------------------------
  const onRun = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (!tabState.currentConnectionId) {
      toast.show("Select a connection first.", "error");
      return;
    }
    const fullSql = ed.getSql();
    const sel = ed.getSelectionRange();
    const cur = ed.getCursor();
    void runner.run({
      connectionId: tabState.currentConnectionId,
      fullSql,
      selectionFrom: sel.from,
      selectionTo: sel.to,
      cursor: cur,
    });
  }, [runner, tabState.currentConnectionId, toast]);

  const onRunAll = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (!tabState.currentConnectionId) {
      toast.show("Select a connection first.", "error");
      return;
    }
    const fullSql = ed.getSql();
    void runner.run({
      connectionId: tabState.currentConnectionId,
      fullSql,
      selectionFrom: 0,
      selectionTo: 0,
      cursor: 0,
      forceAll: true,
    });
  }, [runner, tabState.currentConnectionId, toast]);

  const onShowInEditor = useCallback((offset: number) => {
    editorRef.current?.setCursor(offset);
  }, []);

  const onFormat = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    try {
      ed.formatBuffer();
    } catch (e) {
      console.error("[argus.sql.format]", e);
      toast.show("Could not format SQL", "error");
    }
  }, [toast]);

  // ---------------------------------------------------------------------------
  // Save flow (task 7.3 - 7.7)
  // ---------------------------------------------------------------------------
  const [showSaveAs, setShowSaveAs] = useState(false);
  const [defaultSaveFolder, setDefaultSaveFolder] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Load the lastUsedFolder setting when opening SaveAs.
  const openSaveAsModal = useCallback(() => {
    // Load last-used folder.
    getSetting("savedQueries:lastUsedFolder")
      .then((raw) => setDefaultSaveFolder(raw ?? null))
      .catch(() => setDefaultSaveFolder(null));
    setShowSaveAs(true);
  }, []);

  const onSave = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const currentSql = ed.getSql();

    // 7.4: No-op if not dirty.
    if (!isDirty(tabState, currentSql)) return;

    if (!tabState.savedQueryId) {
      // First save — open modal.
      openSaveAsModal();
    } else {
      // Subsequent save — direct overwrite.
      if (isSaving) return;
      setIsSaving(true);
      const savedId = tabState.savedQueryId;
      const newName = tabState.editedName ?? tabState.savedName;
      savedQueriesStore
        .updateQuery(savedId, { sql: currentSql, name: newName })
        .then((updated) => {
          tabActions.updateSavedSnapshot({
            savedSql: updated.sql,
            savedName: updated.name,
          });
          // Update tab title if name changed.
          setTabTitle(tabId, updated.name);
          toast.show("Saved", "success");
        })
        .catch((e) => {
          toast.show(`Failed to save: ${(e as Error).message ?? String(e)}`, "error");
        })
        .finally(() => setIsSaving(false));
    }
  }, [tabState, isSaving, tabActions, openSaveAsModal, setTabTitle, tabId, toast]);

  // SaveAs modal confirm handler.
  const handleSaveAsConfirm = useCallback(
    async ({ name, folderId }: { name: string; folderId: string | null }) => {
      const currentSql = editorRef.current?.getSql() ?? "";
      setShowSaveAs(false);
      try {
        const q = await savedQueriesStore.createQuery(
          folderId,
          name,
          currentSql,
          tabState.currentConnectionId ?? undefined,
        );
        tabActions.setSaved({
          savedQueryId: q.id,
          savedSql: q.sql,
          savedName: q.name,
          savedFolderId: q.folder_id,
        });
        setTabTitle(tabId, q.name);
        // Persist lastUsedFolder.
        if (folderId) {
          setSetting("savedQueries:lastUsedFolder", folderId).catch(() => {});
        }
        toast.show(`Saved as "${q.name}"`, "success");
      } catch (e) {
        toast.show(`Failed to save: ${(e as Error).message ?? String(e)}`, "error");
      }
    },
    [tabState.currentConnectionId, tabActions, setTabTitle, tabId, toast],
  );

  // ---------------------------------------------------------------------------
  // onChange from editor — update SQL ref and trigger dirty re-render.
  // ---------------------------------------------------------------------------
  const onEditorChange = useCallback(
    (sql: string) => {
      currentSqlRef.current = sql;
      setCurrentSqlForDirty(sql);
      buffer.update(sql);
    },
    [buffer],
  );

  // ---------------------------------------------------------------------------
  // Dirty close confirmation (task 8.4).
  // If dirty and has savedQueryId: show confirm dialog.
  // If dirty and no savedQueryId: close immediately (preserves existing behavior).
  // ---------------------------------------------------------------------------
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);
  const pendingCloseResolveRef = useRef<((ok: boolean) => void) | null>(null);

  useCloseConfirm(
    tabId,
    useCallback(() => {
      const currentSql = currentSqlRef.current;
      const tabIsDirty = isDirty(tabState, currentSql);
      if (!tabIsDirty || !tabState.savedQueryId) {
        // Allow close immediately; clear the buffer (task 8.5).
        buffer.clearBuffer();
        return true;
      }
      // Show confirm dialog. Return a promise that resolves when user decides.
      return new Promise<boolean>((resolve) => {
        pendingCloseResolveRef.current = resolve;
        setShowDiscardDialog(true);
      });
    }, [tabState, buffer]),
  );

  const handleDiscardConfirm = useCallback(() => {
    setShowDiscardDialog(false);
    // Clean up the persisted buffer (task 8.5): the useCloseConfirm handler
    // here overrides the one in useQueryBuffer, so we must call clearBuffer
    // explicitly when the user confirms the discard.
    buffer.clearBuffer();
    pendingCloseResolveRef.current?.(true);
    pendingCloseResolveRef.current = null;
  }, [buffer]);

  const handleDiscardCancel = useCallback(() => {
    setShowDiscardDialog(false);
    pendingCloseResolveRef.current?.(false);
    pendingCloseResolveRef.current = null;
  }, []);

  // ---------------------------------------------------------------------------
  // Resizable result panel.
  // ---------------------------------------------------------------------------
  const [resultHeight, setResultHeight] = useState(280);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>))) return;
    const key = `pgQueryResultHeight:${tabId}`;
    getSetting(key)
      .then((raw) => {
        if (raw) {
          const n = Number.parseInt(raw, 10);
          if (Number.isFinite(n) && n >= 120 && n <= 800) {
            setResultHeight(n);
          }
        }
      })
      .catch(() => {});
  }, [tabId]);

  const persistResultHeight = useCallback(
    (h: number) => {
      if (typeof window === "undefined") return;
      if (!("__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>))) return;
      setSetting(`pgQueryResultHeight:${tabId}`, String(h)).catch(() => {});
    },
    [tabId],
  );

  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const onHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { startY: e.clientY, startH: resultHeight };
      const move = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        const delta = dragRef.current.startY - ev.clientY;
        const next = Math.max(120, Math.min(800, dragRef.current.startH + delta));
        setResultHeight(next);
      };
      const up = () => {
        if (dragRef.current) persistResultHeight(resultHeight);
        dragRef.current = null;
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [resultHeight, persistResultHeight],
  );

  // Display the current connection name in the result header.
  const connectionDisplayName =
    tabState.currentConnectionName ?? payload.initialConnectionName ?? "";

  // Derive the default name for the SaveAs modal.
  // If the tab title is a "Query N" default, leave it empty so the user is
  // prompted. Otherwise pre-fill with the current tab title.
  const saveAsDefaultName = tabState.savedName || "";

  return (
    <div className={styles.root}>
      {isReadOnly ? (
        <div className={styles.readOnlyBanner}>
          <Lock size={11} />
          Read-only connection — non-SELECT statements will be rejected.
        </div>
      ) : null}
      <div className={styles.editorArea}>
        <div className={styles.editorToolbar}>
          {/* Connection selector — leftmost element */}
          <ConnectionSelector
            currentConnectionId={tabState.currentConnectionId}
            onSelect={handleConnectionSelect}
          />
          <span className={styles.toolbarDivider} aria-hidden="true" />
          {/* Save button */}
          <button
            type="button"
            className={styles.toolbarButton}
            onClick={onSave}
            disabled={!dirty || isSaving}
            title={`Save (${SAVE_HINT})`}
            aria-label="Save query"
          >
            <Save size={12} />
            <span>Save</span>
            <span className={styles.kbd}>{SAVE_HINT}</span>
          </button>
          <button
            type="button"
            className={styles.toolbarButton}
            onClick={onFormat}
            title={`Format SQL (${FORMAT_HINT})`}
          >
            <Wand2 size={12} />
            <span>Format</span>
            <span className={styles.kbd}>{FORMAT_HINT}</span>
          </button>
        </div>
        {buffer.loaded ? (
          <QueryEditor
            ref={editorRef}
            connectionId={tabState.currentConnectionId ?? ""}
            initialSql={buffer.initialSql}
            onChange={onEditorChange}
            onRun={onRun}
            onRunAll={onRunAll}
            onFormat={onFormat}
            onSave={onSave}
          />
        ) : (
          <div className={styles.editorPlaceholder}>Loading editor…</div>
        )}
      </div>
      <button
        type="button"
        className={styles.handle}
        aria-label="Resize result panel"
        onMouseDown={onHandleMouseDown}
      />
      <div
        className={styles.resultArea}
        style={{ height: resultHeight, flex: `0 0 ${resultHeight}px` }}
      >
        <div className={styles.resultHeader}>
          <span className={styles.connectionLabel}>{connectionDisplayName}</span>
          <span className={styles.runSummary}>
            <RunSummary
              staticSummary={runner.summary}
              runStartedAt={runner.runStartedAt}
              isRunning={runner.state.status === "running"}
            />
          </span>
          {runner.state.status === "done" &&
          runner.state.mode === "single" &&
          runner.state.result?.kind === "rows" &&
          runner.state.result.rows.length > 0 ? (
            <ExportMenu
              connectionName={connectionDisplayName}
              columns={runner.state.result.columns}
              rows={runner.state.result.rows}
              truncated={runner.state.result.truncated}
            />
          ) : null}
        </div>
        <div className={styles.resultBody}>
          <ResultPanel state={runner.state} onShowInEditor={onShowInEditor} />
        </div>
      </div>

      {/* SaveAs modal */}
      <SaveAsModal
        open={showSaveAs}
        defaultName={saveAsDefaultName}
        defaultFolderId={defaultSaveFolder}
        onClose={() => setShowSaveAs(false)}
        onConfirm={(result) => void handleSaveAsConfirm(result)}
      />

      {/* Discard confirmation dialog (task 8.4) */}
      <Dialog.Root
        open={showDiscardDialog}
        onOpenChange={(o) => {
          if (!o) handleDiscardCancel();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={dialogStyles.overlay} />
          <Dialog.Content className={dialogStyles.content}>
            <Dialog.Title className={dialogStyles.title}>Discard changes?</Dialog.Title>
            <Dialog.Description className={dialogStyles.description}>
              Discard unsaved changes to{" "}
              <strong>
                &ldquo;{tabState.editedName ?? tabState.savedName}&rdquo;
              </strong>
              ? This cannot be undone.
            </Dialog.Description>
            <div className={dialogStyles.footer}>
              <button type="button" onClick={handleDiscardCancel}>
                Cancel
              </button>
              <button
                type="button"
                className={dialogStyles.danger}
                onClick={handleDiscardConfirm}
              >
                Discard
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

TabRegistry.register(POSTGRES_QUERY_KIND, QueryTabRoot);
