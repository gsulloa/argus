import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, Folder } from "lucide-react";
import { contextApi } from "@/modules/context/api";
import type { KnownFolder } from "@/modules/context/types";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { SyncReportModal } from "./SyncReportModal";
import styles from "./ContextFolderRow.module.css";
import { noAutoCorrectProps } from "../../shared/text-input-hygiene";

export interface ContextFolderRowProps {
  connectionId: string;
  contextPath: string | null;
  onChanged: () => void;
}

type RowState = "none" | "linked" | "missing";

// ---------------------------------------------------------------------------
// Inline prompt dialog for folder name
// ---------------------------------------------------------------------------

interface FolderNameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultName: string;
  onSubmit: (name: string) => void;
}

function FolderNameDialog({ open, onOpenChange, defaultName, onSubmit }: FolderNameDialogProps) {
  const [name, setName] = useState(defaultName);

  useEffect(() => {
    if (open) setName(defaultName);
  }, [open, defaultName]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length > 0) {
      onSubmit(trimmed);
      onOpenChange(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.dialogOverlay} />
        <Dialog.Content className={styles.promptDialog}>
          <Dialog.Title className={styles.promptTitle}>New context folder name</Dialog.Title>
          <form onSubmit={handleSubmit} className={styles.promptForm}>
            <input
              {...noAutoCorrectProps}
              className={styles.promptInput}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              placeholder="argus-context"
            />
            <div className={styles.promptFooter}>
              <button
                type="button"
                className={styles.btn}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={name.trim().length === 0}
              >
                Create
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// Confirmation dialog for Unlink
// ---------------------------------------------------------------------------

interface UnlinkConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

function UnlinkConfirmDialog({ open, onOpenChange, onConfirm }: UnlinkConfirmDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.dialogOverlay} />
        <Dialog.Content className={styles.promptDialog}>
          <Dialog.Title className={styles.promptTitle}>Unlink context folder?</Dialog.Title>
          <Dialog.Description className={styles.promptDesc}>
            The files on disk will be left untouched.
          </Dialog.Description>
          <div className={styles.promptFooter}>
            <button
              type="button"
              className={styles.btn}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnDanger}`}
              onClick={() => {
                onConfirm();
                onOpenChange(false);
              }}
            >
              Unlink
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// Main ContextFolderRow
// ---------------------------------------------------------------------------

export function ContextFolderRow({ connectionId, contextPath, onChanged }: ContextFolderRowProps) {
  const { items: connections } = useConnections();

  // Derive row state
  const [availabilityChecked, setAvailabilityChecked] = useState(false);
  const [isMissing, setIsMissing] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);

  // UI state
  const [busy, setBusy] = useState(false);
  const [showNameDialog, setShowNameDialog] = useState(false);
  const [pendingParentPath, setPendingParentPath] = useState<string | null>(null);
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState(false);
  const [showSyncModal, setShowSyncModal] = useState(false);
  const syncChangedRef = useRef(false);

  // Known-folder discovery (loaded when state is "none")
  const [knownFolders, setKnownFolders] = useState<KnownFolder[] | null>(null);
  const [knownFoldersLoading, setKnownFoldersLoading] = useState(false);

  // Availability check: call listObjects; if it throws a "not found" / missing-manifest
  // error, treat as missing. Any other error → show inline, keep as linked.
  useEffect(() => {
    if (contextPath == null) {
      setAvailabilityChecked(false);
      setIsMissing(false);
      setInlineError(null);
      return;
    }

    setAvailabilityChecked(false);
    setIsMissing(false);
    setInlineError(null);

    contextApi.listObjects(connectionId).then(() => {
      setAvailabilityChecked(true);
      setIsMissing(false);
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      const lc = msg.toLowerCase();
      if (
        lc.includes("not found") ||
        lc.includes("missingmanifest") ||
        lc.includes("missing_manifest") ||
        lc.includes("unsupportedmanifestversion") ||
        lc.includes("unsupported_manifest_version")
      ) {
        setAvailabilityChecked(true);
        setIsMissing(true);
      } else {
        console.warn("[ContextFolderRow] availability check error:", err);
        setAvailabilityChecked(true);
        setIsMissing(false);
        setInlineError(msg);
      }
    });
  }, [connectionId, contextPath]);

  const state: RowState =
    contextPath == null
      ? "none"
      : availabilityChecked && isMissing
        ? "missing"
        : "linked";

  // Load known folders whenever the row enters the "none" state, so we can
  // offer reuse as the primary choice.
  useEffect(() => {
    if (state !== "none") {
      setKnownFolders(null);
      return;
    }
    setKnownFoldersLoading(true);
    contextApi.listKnownFolders().then((folders) => {
      setKnownFolders(folders);
    }).catch(() => {
      // On error (e.g. command not yet registered in older builds) fall back
      // gracefully to the original create/link flow.
      setKnownFolders([]);
    }).finally(() => {
      setKnownFoldersLoading(false);
    });
  }, [state]);

  // "Shared with N" count
  const sharedCount = contextPath != null
    ? connections.filter(
        (c) => c.id !== connectionId && c.context_path === contextPath,
      ).length
    : 0;

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  async function handleReuseFolder(path: string) {
    setBusy(true);
    setInlineError(null);
    try {
      await contextApi.linkFolder(connectionId, path);
      onChanged();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setInlineError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateFolder() {
    const parentPath = await dialogOpen({
      directory: true,
      multiple: false,
      title: "Choose a parent directory for the new context folder",
    });
    if (!parentPath || typeof parentPath !== "string") return;
    setPendingParentPath(parentPath);
    setShowNameDialog(true);
  }

  async function handleCreateFolderWithName(name: string) {
    if (!pendingParentPath) return;
    const fullPath = `${pendingParentPath}/${name}`;
    setBusy(true);
    setInlineError(null);
    try {
      const canonPath = await contextApi.createFolder(fullPath, name);
      await contextApi.linkFolder(connectionId, canonPath);
      onChanged();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setInlineError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleLinkExisting() {
    const picked = await dialogOpen({
      directory: true,
      multiple: false,
      title: "Select context folder",
    });
    if (!picked || typeof picked !== "string") return;
    setBusy(true);
    setInlineError(null);
    try {
      await contextApi.linkFolder(connectionId, picked);
      onChanged();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setInlineError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleReveal() {
    if (!contextPath) return;
    try {
      await contextApi.revealPath(contextPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setInlineError(msg);
    }
  }

  async function handleUnlink() {
    setBusy(true);
    setInlineError(null);
    try {
      await contextApi.unlink(connectionId);
      onChanged();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setInlineError(msg);
    } finally {
      setBusy(false);
    }
  }

  function handleSyncModalClose(open: boolean) {
    setShowSyncModal(open);
    if (!open && syncChangedRef.current) {
      syncChangedRef.current = false;
      onChanged();
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className={styles.row}>
      <div className={styles.label}>Context folder</div>

      {state === "none" && (
        <div className={styles.noneState}>
          {/* Primary: reuse an existing known folder */}
          {knownFoldersLoading && (
            <p className={styles.hint}>Loading existing folders…</p>
          )}
          {!knownFoldersLoading && knownFolders != null && knownFolders.length > 0 && (
            <div className={styles.knownFolderList}>
              {knownFolders.map((folder) => (
                <button
                  key={folder.path}
                  type="button"
                  className={styles.knownFolderItem}
                  disabled={busy}
                  onClick={() => void handleReuseFolder(folder.path)}
                >
                  <Folder size={12} className={styles.folderIcon} />
                  <span className={styles.knownFolderName}>{folder.name}</span>
                  <span className={styles.knownFolderPath}>{folder.path}</span>
                </button>
              ))}
            </div>
          )}

          {/* Secondary: create new or choose any folder */}
          <div className={styles.btnGroup}>
            <button
              type="button"
              className={styles.btn}
              disabled={busy}
              onClick={() => void handleCreateFolder()}
            >
              {(!knownFolders || knownFolders.length === 0) ? "Create folder…" : "New folder…"}
            </button>
            <button
              type="button"
              className={styles.btn}
              disabled={busy}
              onClick={() => void handleLinkExisting()}
            >
              {(!knownFolders || knownFolders.length === 0) ? "Link existing…" : "Choose other…"}
            </button>
          </div>
          <p className={styles.hint}>
            A context folder holds documentation and prefab queries on disk — shareable across connections via git.
          </p>
        </div>
      )}

      {state === "linked" && contextPath != null && (
        <div className={styles.linkedState}>
          <div className={styles.pathRow}>
            <Folder size={12} className={styles.folderIcon} />
            <span className={styles.pathText}>{contextPath}</span>
          </div>
          {sharedCount > 0 && (
            <span className={styles.sharedHint}>
              Shared with {sharedCount} other connection{sharedCount > 1 ? "s" : ""}
            </span>
          )}
          <div className={styles.btnGroup}>
            <button
              type="button"
              className={styles.btn}
              disabled={busy}
              onClick={() => void handleReveal()}
            >
              Reveal
            </button>
            <button
              type="button"
              className={styles.btn}
              disabled={busy}
              onClick={() => setShowUnlinkConfirm(true)}
            >
              Unlink
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={busy}
              onClick={() => setShowSyncModal(true)}
            >
              Sync schema…
            </button>
          </div>
        </div>
      )}

      {state === "missing" && contextPath != null && (
        <div className={styles.missingState}>
          <div className={styles.pathRow}>
            <AlertTriangle size={12} className={styles.warnIcon} />
            <span className={`${styles.pathText} ${styles.pathTextDanger}`}>{contextPath}</span>
          </div>
          <span className={styles.missingHint}>Folder not found on disk.</span>
          <div className={styles.btnGroup}>
            <button
              type="button"
              className={styles.btn}
              disabled={busy}
              onClick={() => void handleLinkExisting()}
            >
              Locate…
            </button>
            <button
              type="button"
              className={styles.btn}
              disabled={busy}
              onClick={() => setShowUnlinkConfirm(true)}
            >
              Unlink
            </button>
          </div>
        </div>
      )}

      {inlineError && (
        <div className={styles.inlineError}>{inlineError}</div>
      )}

      {/* Name prompt dialog (for Create folder) */}
      <FolderNameDialog
        open={showNameDialog}
        onOpenChange={setShowNameDialog}
        defaultName="argus-context"
        onSubmit={(name) => void handleCreateFolderWithName(name)}
      />

      {/* Unlink confirmation dialog */}
      <UnlinkConfirmDialog
        open={showUnlinkConfirm}
        onOpenChange={setShowUnlinkConfirm}
        onConfirm={() => void handleUnlink()}
      />

      {/* Sync report modal */}
      <SyncReportModal
        open={showSyncModal}
        onOpenChange={handleSyncModalClose}
        connectionId={connectionId}
        onSynced={() => {
          syncChangedRef.current = true;
        }}
      />
    </div>
  );
}
