/**
 * SaveAsModal — first-save dialog for postgres-query tabs.
 *
 * Shows a Name input and a folder picker (tree of saved_query_folders).
 * Includes an inline "+ New folder…" affordance.
 *
 * Props:
 *  - `defaultName`   — pre-filled value for the Name field.
 *  - `defaultFolderId` — folder pre-selected on open (from lastUsedFolder setting).
 *  - `open`          — controls Radix dialog visibility.
 *  - `onClose`       — called when the user cancels.
 *  - `onConfirm`     — called with { name, folderId } when the user saves.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronDown, ChevronRight, Folder, FolderPlus } from "lucide-react";
import { useSavedQueries } from "./useSavedQueries";
import type { FolderNode } from "./types";
import dialogStyles from "@/platform/shell/Dialog.module.css";
import styles from "./SaveAsModal.module.css";
import { noAutoCorrectProps } from "../shared/text-input-hygiene";

export interface SaveAsModalProps {
  open: boolean;
  defaultName: string;
  defaultFolderId: string | null;
  onClose: () => void;
  onConfirm: (result: { name: string; folderId: string | null }) => void;
}

export function SaveAsModal({
  open,
  defaultName,
  defaultFolderId,
  onClose,
  onConfirm,
}: SaveAsModalProps) {
  const { folders, tree, actions } = useSavedQueries();
  const [name, setName] = useState(defaultName);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(defaultFolderId);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // Reset fields when opened.
  useEffect(() => {
    if (open) {
      setName(defaultName);
      setSelectedFolderId(defaultFolderId);
      setShowNewFolder(false);
      setNewFolderName("");
      // Auto-expand ancestor folders so the default selection is visible.
      if (defaultFolderId) {
        const ancestors = new Set<string>();
        let current = folders.find((f) => f.id === defaultFolderId);
        while (current?.parent_id) {
          ancestors.add(current.parent_id);
          current = folders.find((f) => f.id === current!.parent_id);
        }
        setExpandedFolderIds(ancestors);
      }
      // Focus name input.
      setTimeout(() => nameRef.current?.focus(), 0);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggleExpand = (id: string) => {
    setExpandedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCreateFolder = useCallback(async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) return;
    setIsCreatingFolder(true);
    try {
      const folder = await actions.createFolder(selectedFolderId, trimmed);
      setSelectedFolderId(folder.id);
      // Auto-expand parent if needed.
      if (selectedFolderId) {
        setExpandedFolderIds((prev) => new Set([...prev, selectedFolderId]));
      }
      setShowNewFolder(false);
      setNewFolderName("");
    } catch (e) {
      console.error("[argus.save-as] create folder:", e);
    } finally {
      setIsCreatingFolder(false);
    }
  }, [actions, newFolderName, selectedFolderId]);

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onConfirm({ name: trimmed, folderId: selectedFolderId });
  };

  const selectedFolderName = selectedFolderId
    ? folders.find((f) => f.id === selectedFolderId)?.name ?? "Unknown folder"
    : "Root (no folder)";

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.overlay} />
        <Dialog.Content className={dialogStyles.content} style={{ minWidth: 400 }}>
          <Dialog.Title className={dialogStyles.title}>Save Query</Dialog.Title>

          {/* Name field */}
          <label className={styles.label} htmlFor="save-as-name">Name</label>
          <input
            {...noAutoCorrectProps}
            id="save-as-name"
            ref={nameRef}
            type="text"
            className={styles.input}
            placeholder="Query name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
              if (e.key === "Escape") onClose();
            }}
          />

          {/* Folder picker */}
          <label className={styles.label}>Folder</label>
          <div className={styles.folderDisplay}>
            <span className={styles.folderDisplayName}>{selectedFolderName}</span>
          </div>

          <div className={styles.folderTree}>
            {/* Root option */}
            <button
              type="button"
              className={styles.folderItem}
              data-selected={selectedFolderId === null || undefined}
              onClick={() => setSelectedFolderId(null)}
            >
              <span className={styles.folderIndent} style={{ width: 0 }} />
              <span className={styles.folderIcon} aria-hidden="true">—</span>
              <span className={styles.folderName}>Root (no folder)</span>
            </button>

            {tree.map((node) =>
              node.kind === "folder" ? (
                <FolderPickerNode
                  key={node.id}
                  node={node}
                  depth={0}
                  selectedFolderId={selectedFolderId}
                  expandedFolderIds={expandedFolderIds}
                  onSelect={(id) => setSelectedFolderId(id)}
                  onToggle={(id) => toggleExpand(id)}
                />
              ) : null,
            )}
          </div>

          {/* New folder affordance */}
          {showNewFolder ? (
            <div className={styles.newFolderRow}>
              <input
                {...noAutoCorrectProps}
                type="text"
                className={styles.input}
                placeholder={
                  selectedFolderId
                    ? `New folder inside "${selectedFolderName}"…`
                    : "New root folder…"
                }
                value={newFolderName}
                autoFocus
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCreateFolder();
                  if (e.key === "Escape") {
                    setShowNewFolder(false);
                    setNewFolderName("");
                  }
                }}
              />
              <button
                type="button"
                className={styles.newFolderConfirm}
                disabled={isCreatingFolder || !newFolderName.trim()}
                onClick={() => void handleCreateFolder()}
              >
                {isCreatingFolder ? "Creating…" : "Create"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={styles.newFolderLink}
              onClick={() => setShowNewFolder(true)}
            >
              <FolderPlus size={11} />
              New folder…
            </button>
          )}

          <div className={dialogStyles.footer} style={{ marginTop: 16 }}>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className={dialogStyles.primary}
              disabled={!name.trim()}
              onClick={handleSubmit}
            >
              Save
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface FolderPickerNodeProps {
  node: FolderNode;
  depth: number;
  selectedFolderId: string | null;
  expandedFolderIds: Set<string>;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}

function FolderPickerNode({
  node,
  depth,
  selectedFolderId,
  expandedFolderIds,
  onSelect,
  onToggle,
}: FolderPickerNodeProps) {
  const expanded = expandedFolderIds.has(node.id);
  const childFolders = node.children.filter((c): c is FolderNode => c.kind === "folder");
  const hasChildren = childFolders.length > 0;
  const isSelected = node.id === selectedFolderId;

  return (
    <>
      <button
        type="button"
        className={styles.folderItem}
        data-selected={isSelected || undefined}
        onClick={() => onSelect(node.id)}
      >
        <span className={styles.folderIndent} style={{ width: depth * 14 }} />
        {hasChildren ? (
          <span
            className={styles.folderToggle}
            role="button"
            tabIndex={-1}
            aria-label={expanded ? "Collapse" : "Expand"}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.id);
            }}
          >
            {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </span>
        ) : (
          <span className={styles.folderTogglePlaceholder} />
        )}
        <Folder size={11} className={styles.folderIcon} aria-hidden="true" />
        <span className={styles.folderName}>{node.name}</span>
      </button>

      {expanded && hasChildren &&
        childFolders.map((child) => (
          <FolderPickerNode
            key={child.id}
            node={child}
            depth={depth + 1}
            selectedFolderId={selectedFolderId}
            expandedFolderIds={expandedFolderIds}
            onSelect={onSelect}
            onToggle={onToggle}
          />
        ))}
    </>
  );
}
