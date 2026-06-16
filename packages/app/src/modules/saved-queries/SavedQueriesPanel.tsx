/**
 * SavedQueriesPanel — sidebar section rendering the saved-queries tree.
 *
 * Tasks covered: 4.1–4.10, 9.1–9.4
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { FileCode2, Folder, FolderOpen, Plus } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { useTabs } from "@/platform/shell/tabs";
import { SidebarTree, type TreeNode as SidebarTreeNode, type DndDropResult } from "@/platform/shell/SidebarTree";
import { useSidebarScrollRef } from "@/platform/shell/sidebarScroll";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { useToast } from "@/platform/toast";
import { getSetting, setSetting } from "@/platform/settings/api";
import { useSavedQueries } from "./useSavedQueries";
import { openSavedQuery, openSavedQueryInNew } from "./openSavedQuery";
import { FolderPicker } from "./FolderPicker";
import type { FolderNode, QueryNode, SavedQueryFolder, TreeNode as SqTreeNode } from "./types";
import dialogStyles from "@/platform/shell/Dialog.module.css";
import styles from "./SavedQueriesPanel.module.css";
import { noAutoCorrectProps } from "../shared/text-input-hygiene";

// ---------------------------------------------------------------------------
// Settings key
// ---------------------------------------------------------------------------

const EXPANDED_FOLDERS_KEY = "savedQueries:expandedFolders";
const DEBOUNCE_MS = 200;

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

// ---------------------------------------------------------------------------
// Tree node mapping — SqTreeNode (saved-queries) → SidebarTreeNode (SidebarTree)
// ---------------------------------------------------------------------------

function sqNodeToSidebarNode(node: SqTreeNode, level: number): SidebarTreeNode {
  if (node.kind === "folder") {
    return {
      id: `folder:${node.id}`,
      label: node.name,
      level,
      hasChildren: node.children.length > 0,
      children: node.children.map((c) => sqNodeToSidebarNode(c, level + 1)),
      data: node,
    };
  }
  return {
    id: `query:${node.id}`,
    label: node.name,
    level,
    hasChildren: false,
    data: node,
  };
}

function buildSidebarNodes(tree: SqTreeNode[]): SidebarTreeNode[] {
  return tree.map((n) => sqNodeToSidebarNode(n, 0));
}

// ---------------------------------------------------------------------------
// Filter tree (mirrors SchemaTree pattern)
// ---------------------------------------------------------------------------

function filterNodes(
  nodes: SidebarTreeNode[],
  needle: string,
  forceExpanded: Set<string>,
): SidebarTreeNode[] {
  if (!needle) return nodes;

  function walk(node: SidebarTreeNode): SidebarTreeNode | null {
    if (node.hasChildren && node.children) {
      const filtered: SidebarTreeNode[] = [];
      for (const c of node.children) {
        const fc = walk(c);
        if (fc) filtered.push(fc);
      }
      if (filtered.length > 0) {
        forceExpanded.add(node.id);
        return { ...node, children: filtered };
      }
      // No matching children — check if this folder's name itself matches.
      if (node.label.toLowerCase().includes(needle)) {
        return { ...node, children: [], hasChildren: false };
      }
      return null;
    }
    if (node.label.toLowerCase().includes(needle)) return node;
    return null;
  }

  const out: SidebarTreeNode[] = [];
  for (const n of nodes) {
    const fn = walk(n);
    if (fn) out.push(fn);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parse a sidebar node id → { kind, id }
// ---------------------------------------------------------------------------

function parseNodeId(id: string): { kind: "folder" | "query"; rawId: string } | null {
  if (id.startsWith("folder:")) return { kind: "folder", rawId: id.slice(7) };
  if (id.startsWith("query:")) return { kind: "query", rawId: id.slice(6) };
  return null;
}

// ---------------------------------------------------------------------------
// Count descendants recursively
// ---------------------------------------------------------------------------

function countDescendants(node: FolderNode): number {
  let n = 0;
  for (const c of node.children) {
    n += 1;
    if (c.kind === "folder") n += countDescendants(c);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Client-side cycle detection for DnD folder moves
// ---------------------------------------------------------------------------

/**
 * Returns true if `candidateAncestorId` is the same as `folderId` or is a
 * descendant of it — in which case moving `folderId` under `candidateAncestorId`
 * would create a cycle.
 *
 * Walks the full tree rather than the DB to avoid an extra round-trip.
 */
function isCycleMove(
  folderId: string,
  targetId: string,
  tree: SqTreeNode[],
): boolean {
  // Collect all descendant folder ids of folderId
  function collectDescendants(nodes: SqTreeNode[], result: Set<string>): void {
    for (const n of nodes) {
      if (n.kind === "folder") {
        result.add(n.id);
        collectDescendants(n.children, result);
      }
    }
  }

  // Find the folder node in the tree
  function findFolder(nodes: SqTreeNode[], id: string): FolderNode | null {
    for (const n of nodes) {
      if (n.kind === "folder") {
        if (n.id === id) return n;
        const found = findFolder(n.children, id);
        if (found) return found;
      }
    }
    return null;
  }

  const folderNode = findFolder(tree, folderId);
  if (!folderNode) return false;

  // Self-move is a cycle
  if (folderId === targetId) return true;

  const descendants = new Set<string>();
  collectDescendants(folderNode.children, descendants);
  return descendants.has(targetId);
}

function findFolderInTree(tree: SqTreeNode[], rawId: string): FolderNode | undefined {
  for (const n of tree) {
    if (n.kind === "folder") {
      if (n.id === rawId) return n;
      const found = findFolderInTree(n.children, rawId);
      if (found) return found;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Context target resolution from contextmenu event
// ---------------------------------------------------------------------------

function findNodeByLabel(nodes: SidebarTreeNode[], label: string): SidebarTreeNode | undefined {
  for (const n of nodes) {
    if (n.label === label) return n;
    if (n.children) {
      const found = findNodeByLabel(n.children, label);
      if (found) return found;
    }
  }
  return undefined;
}

interface ContextTarget {
  kind: "query" | "folder" | "root";
  node?: SqTreeNode;
}

function resolveContextTarget(
  e: MouseEvent,
  sidebarNodes: SidebarTreeNode[],
): ContextTarget {
  let el = e.target as HTMLElement | null;
  while (el && el !== e.currentTarget) {
    if (el.getAttribute("role") === "treeitem") {
      const label = el.getAttribute("title") ?? "";
      const found = findNodeByLabel(sidebarNodes, label);
      if (found) {
        const parsed = parseNodeId(found.id);
        if (parsed) {
          const sqNode = found.data as SqTreeNode;
          return { kind: parsed.kind, node: sqNode };
        }
      }
    }
    el = el.parentElement;
  }
  return { kind: "root" };
}

// ---------------------------------------------------------------------------
// Confirm dialog
// ---------------------------------------------------------------------------

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  dangerous?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  dangerous = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.overlay} />
        <Dialog.Content className={dialogStyles.content}>
          <Dialog.Title className={dialogStyles.title}>{title}</Dialog.Title>
          <Dialog.Description className={dialogStyles.description}>
            {description}
          </Dialog.Description>
          <div className={dialogStyles.footer}>
            <button autoFocus onClick={onCancel}>
              Cancel
            </button>
            <button
              onClick={onConfirm}
              className={dangerous ? undefined : dialogStyles.primary}
              style={
                dangerous
                  ? {
                      background: "var(--danger)",
                      color: "var(--accent-text, #fff)",
                      border: "1px solid var(--danger)",
                      padding: "5px 12px",
                      borderRadius: 4,
                      fontWeight: 500,
                    }
                  : undefined
              }
            >
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// Move to folder dialog
// ---------------------------------------------------------------------------

interface MoveToFolderDialogProps {
  open: boolean;
  queryName: string;
  folders: SavedQueryFolder[];
  currentFolderId: string | null;
  onConfirm: (targetFolderId: string | null) => void;
  onCancel: () => void;
}

function MoveToFolderDialog({
  open,
  queryName,
  folders,
  currentFolderId,
  onConfirm,
  onCancel,
}: MoveToFolderDialogProps) {
  const [selectedId, setSelectedId] = useState<string | null>(currentFolderId);

  useEffect(() => {
    if (open) setSelectedId(currentFolderId);
  }, [open, currentFolderId]);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.overlay} />
        <Dialog.Content className={dialogStyles.content}>
          <Dialog.Title className={dialogStyles.title}>Move to folder</Dialog.Title>
          <Dialog.Description className={dialogStyles.description}>
            Choose a destination for <strong>{queryName}</strong>.
          </Dialog.Description>
          <FolderPicker
            folders={folders}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
          <div className={dialogStyles.footer}>
            <button onClick={onCancel}>Cancel</button>
            <button
              className={dialogStyles.primary}
              onClick={() => onConfirm(selectedId)}
            >
              Move
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// Inline rename input
// ---------------------------------------------------------------------------

interface RenameInputProps {
  initialName: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}

function RenameInput({ initialName, onCommit, onCancel }: RenameInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialName);

  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  function commit() {
    const trimmed = value.trim();
    if (trimmed) onCommit(trimmed);
    else onCancel();
  }

  return (
    <input
      {...noAutoCorrectProps}
      ref={inputRef}
      type="text"
      className={styles.renameInput}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      }}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

interface DeleteTarget {
  kind: "query" | "folder";
  id: string;
  name: string;
  /** For folders: total descendant count (0 = empty). */
  descendantCount: number;
}

interface MoveTarget {
  queryId: string;
  queryName: string;
  currentFolderId: string | null;
}

export function SavedQueriesPanel() {
  const { tree, folders, queries, loading, error, actions } = useSavedQueries();
  const tabs = useTabs();
  const { items: connections } = useConnections();
  const toast = useToast();
  const sidebarScrollRef = useSidebarScrollRef();

  // ---- Search state ----
  const [searchQuery, setSearchQuery] = useState("");

  // ---- Expansion persistence ----
  // We keep two sets:
  //   `persistedExpanded` — the user's explicitly toggled set (persisted)
  //   `searchExpanded`    — auto-expanded during search (NOT persisted)
  const [persistedExpanded, setPersistedExpanded] = useState<Set<string>>(new Set());
  const [searchExpanded, setSearchExpanded] = useState<Set<string>>(new Set());
  const persistTimerRef = useRef<number | null>(null);

  // Load persisted expansion on mount
  useEffect(() => {
    if (!isTauriRuntime()) return;
    getSetting(EXPANDED_FOLDERS_KEY)
      .then((raw) => {
        if (!raw) return;
        try {
          const ids = JSON.parse(raw) as string[];
          setPersistedExpanded(new Set(ids));
        } catch {
          // ignore malformed
        }
      })
      .catch(() => {});
  }, []);

  // Persist with debounce
  function schedulePersistedExpansionWrite(ids: Set<string>) {
    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      if (!isTauriRuntime()) return;
      setSetting(EXPANDED_FOLDERS_KEY, JSON.stringify([...ids])).catch(() => {});
    }, DEBOUNCE_MS);
  }

  // Build sidebar nodes from tree
  const sidebarNodes = useMemo(() => buildSidebarNodes(tree), [tree]);

  // Compute filtered nodes + forced expansion during search
  const { filteredNodes, forceExpanded } = useMemo(() => {
    if (!searchQuery.trim()) {
      return { filteredNodes: sidebarNodes, forceExpanded: new Set<string>() };
    }
    const needle = searchQuery.toLowerCase();
    const fe = new Set<string>();
    const nodes = filterNodes(sidebarNodes, needle, fe);
    return { filteredNodes: nodes, forceExpanded: fe };
  }, [sidebarNodes, searchQuery]);

  // Update search-driven expansion without touching persisted set
  useEffect(() => {
    if (searchQuery.trim()) {
      setSearchExpanded(forceExpanded);
    } else {
      setSearchExpanded(new Set());
    }
  }, [forceExpanded, searchQuery]);

  // Combined forceExpanded: persisted union search-driven (search takes priority).
  const combinedForceExpanded = useMemo(() => {
    if (!searchQuery.trim()) {
      // No search: only use persisted set (via defaultExpanded, forceExpanded is empty).
      return new Set<string>();
    }
    return searchExpanded;
  }, [searchExpanded, searchQuery]);

  // Flat list of visible nodes — used for DnD sibling resolution.
  // Mirrors what SidebarTree renders internally.
  const flat = useMemo(() => {
    function flattenNodes(
      nodes: SidebarTreeNode[],
      isExp: (id: string) => boolean,
      out: Array<{ node: SidebarTreeNode }>,
    ) {
      for (const node of nodes) {
        out.push({ node });
        if (node.hasChildren && node.children && isExp(node.id)) {
          flattenNodes(node.children, isExp, out);
        }
      }
    }
    const out: Array<{ node: SidebarTreeNode }> = [];
    const isExp = (id: string) =>
      persistedExpanded.has(id) || combinedForceExpanded.has(id);
    flattenNodes(filteredNodes, isExp, out);
    return out;
  }, [filteredNodes, persistedExpanded, combinedForceExpanded]);

  // defaultExpanded: initialized from persisted set. SidebarTree manages internal
  // toggle state; we pass the initial value and handle toggle callbacks.
  const defaultExpandedSet = useMemo(
    () => persistedExpanded,
    // We only want this to initialize once per load — eslint-disable-next-line intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Track SidebarTree toggle events to update persisted expansion.
  const handleToggle = useCallback(
    (node: SidebarTreeNode, expanded: boolean) => {
      // Only persist folder toggles (not query nodes which have no children).
      if (!node.id.startsWith("folder:")) return;
      setPersistedExpanded((prev) => {
        const next = new Set(prev);
        if (expanded) next.add(node.id);
        else next.delete(node.id);
        schedulePersistedExpansionWrite(next);
        return next;
      });
    },
    [],
  );

  // ---- Rename state ----
  const [renamingId, setRenamingId] = useState<string | null>(null); // sidebar node id (e.g. "folder:xxx")

  // ---- Delete confirm ----
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  // ---- Move to folder ----
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);

  // ---- Context menu ----
  const [contextTarget, setContextTarget] = useState<ContextTarget>({ kind: "root" });
  // Reset context target when the context menu closes.
  const handleContextMenuOpenChange = useCallback(
    (open: boolean) => { if (!open) setContextTarget({ kind: "root" }); },
    [],
  );
  // Resolve the right-clicked node from the DOM event before the menu opens.
  const handleContextMenuCapture = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      setContextTarget(resolveContextTarget(e, sidebarNodes));
    },
    [sidebarNodes],
  );

  // ---- Actions ----

  async function handleCreateQuery(parentFolderId: string | null | undefined) {
    try {
      const q = await actions.createQuery(parentFolderId, "Untitled", "");
      // Open the new query in a tab
      openSavedQuery(tabs, { items: connections }, q.id);
    } catch (e) {
      toast.show(`Failed to create query: ${(e as Error).message}`, "error");
    }
  }

  async function handleCreateFolder(parentFolderId: string | null | undefined) {
    try {
      await actions.createFolder(parentFolderId, "New folder");
    } catch (e) {
      toast.show(`Failed to create folder: ${(e as Error).message}`, "error");
    }
  }

  async function handleRenameCommit(sidebarNodeId: string, newName: string) {
    const parsed = parseNodeId(sidebarNodeId);
    if (!parsed) return;
    try {
      if (parsed.kind === "folder") {
        await actions.updateFolder(parsed.rawId, newName);
      } else {
        await actions.updateQuery(parsed.rawId, { name: newName });
      }
    } catch (e) {
      toast.show(`Rename failed: ${(e as Error).message}`, "error");
    } finally {
      setRenamingId(null);
    }
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.kind === "query") {
        await actions.deleteQuery(deleteTarget.id);
      } else {
        await actions.deleteFolder(deleteTarget.id);
      }
    } catch (e) {
      toast.show(`Delete failed: ${(e as Error).message}`, "error");
    } finally {
      setDeleteTarget(null);
    }
  }

  async function handleDuplicate(queryId: string) {
    try {
      await actions.duplicateQuery(queryId);
    } catch (e) {
      toast.show(`Duplicate failed: ${(e as Error).message}`, "error");
    }
  }

  async function handleMoveQuery(queryId: string, targetFolderId: string | null) {
    try {
      await actions.moveQuery(queryId, targetFolderId);
    } catch (e) {
      toast.show(`Move failed: ${(e as Error).message}`, "error");
    }
  }

  // ---- DnD drop handler ----
  const handleDndDrop = useCallback(
    async (draggedSidebarId: string, drop: DndDropResult) => {
      const draggedParsed = parseNodeId(draggedSidebarId);
      if (!draggedParsed) return;

      const { kind: draggedKind, rawId: draggedRawId } = draggedParsed;

      if (drop.type === "root") {
        // Move to root (parentId/folderId = null)
        try {
          if (draggedKind === "query") {
            await actions.moveQuery(draggedRawId, null);
          } else {
            await actions.moveFolder(draggedRawId, null);
          }
        } catch (e) {
          toast.show(`Move failed: ${(e as Error).message}`, "error");
        }
        return;
      }

      if (drop.type === "into") {
        // Drop onto a folder row — move into that folder
        const targetParsed = parseNodeId(drop.targetId);
        if (!targetParsed || targetParsed.kind !== "folder") return;
        const targetFolderRawId = targetParsed.rawId;

        try {
          if (draggedKind === "query") {
            await actions.moveQuery(draggedRawId, targetFolderRawId);
          } else {
            // Cycle check already done in isDndDropAllowed, but double-check:
            if (isCycleMove(draggedRawId, targetFolderRawId, tree)) {
              toast.show("Cannot move folder into its own descendant.", "error");
              return;
            }
            await actions.moveFolder(draggedRawId, targetFolderRawId);
          }
        } catch (e) {
          const msg = (e as Error).message ?? String(e);
          if (msg.toLowerCase().includes("descendant") || msg.toLowerCase().includes("cycle")) {
            toast.show("Cannot move folder into its own descendant.", "error");
          } else {
            toast.show(`Move failed: ${msg}`, "error");
          }
        }
        return;
      }

      // drop.type === "before" | "after" — reorder within the same parent
      const targetParsed = parseNodeId(drop.targetId);
      if (!targetParsed) return;
      const targetNode = flat.find((f) => f.node.id === drop.targetId);
      if (!targetNode) return;

      // Determine the target parent (folder id) from the target node's data
      const targetSqNode = targetNode.node.data as SqTreeNode | undefined;
      if (!targetSqNode) return;

      const targetParentId: string | null =
        targetSqNode.kind === "folder"
          ? targetSqNode.parentId
          : targetSqNode.folderId;

      // Find the siblings and compute the target sort order
      const siblings = flat.filter((f) => {
        const sqNode = f.node.data as SqTreeNode | undefined;
        if (!sqNode) return false;
        const parentId = sqNode.kind === "folder" ? sqNode.parentId : sqNode.folderId;
        return parentId === targetParentId && f.node.id !== draggedSidebarId;
      });

      const targetIdx = siblings.findIndex((f) => f.node.id === drop.targetId);
      const insertIdx = drop.type === "before" ? targetIdx : targetIdx + 1;
      // Compute the sort order based on neighbors
      const prevSibling = insertIdx > 0 ? siblings[insertIdx - 1] : null;
      const nextSibling = siblings[insertIdx] ?? null;

      const prevOrder = prevSibling
        ? ((prevSibling.node.data as SqTreeNode).sortOrder)
        : 0;
      const nextOrder = nextSibling
        ? ((nextSibling.node.data as SqTreeNode).sortOrder)
        : prevOrder + 2;

      // Use midpoint between neighbors; fall back to simple insertion
      const targetSortOrder = Math.round((prevOrder + nextOrder) / 2);

      try {
        if (draggedKind === "query") {
          await actions.moveQuery(draggedRawId, targetParentId, targetSortOrder);
        } else {
          if (targetParentId && isCycleMove(draggedRawId, targetParentId, tree)) {
            toast.show("Cannot move folder into its own descendant.", "error");
            return;
          }
          await actions.moveFolder(draggedRawId, targetParentId, targetSortOrder);
        }
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        if (msg.toLowerCase().includes("descendant") || msg.toLowerCase().includes("cycle")) {
          toast.show("Cannot move folder into its own descendant.", "error");
        } else {
          toast.show(`Move failed: ${msg}`, "error");
        }
      }
    },
    [actions, flat, tree, toast],
  );

  // ---- DnD drop allowed check (client-side cycle prevention) ----
  const isDndDropAllowed = useCallback(
    (draggedSidebarId: string, overSidebarId: string): boolean => {
      const draggedParsed = parseNodeId(draggedSidebarId);
      const overParsed = parseNodeId(overSidebarId);
      if (!draggedParsed || !overParsed) return false;
      // Folders cannot be dropped into their own descendants
      if (draggedParsed.kind === "folder" && overParsed.kind === "folder") {
        return !isCycleMove(draggedParsed.rawId, overParsed.rawId, tree);
      }
      return true;
    },
    [tree],
  );

  function requestDelete(kind: "query" | "folder", rawId: string) {
    if (kind === "query") {
      const q = queries.find((x) => x.id === rawId);
      if (!q) return;
      setDeleteTarget({ kind: "query", id: rawId, name: q.name, descendantCount: 0 });
    } else {
      const f = findFolderInTree(tree, rawId);
      if (!f) return;
      const desc = countDescendants(f);
      setDeleteTarget({ kind: "folder", id: rawId, name: f.name, descendantCount: desc });
    }
  }

  // ---- Activate (double-click / Enter) ----
  function onActivate(sidebarNode: SidebarTreeNode) {
    const parsed = parseNodeId(sidebarNode.id);
    if (!parsed || parsed.kind !== "query") return;
    openSavedQuery(tabs, { items: connections }, parsed.rawId);
  }

  // ---- Render icon ----
  function renderIcon(node: SidebarTreeNode): ReactNode {
    const sqNode = node.data as SqTreeNode | undefined;
    if (!sqNode) return null;
    if (sqNode.kind === "folder") {
      const isExpanded = node.hasChildren && combinedForceExpanded.has(node.id);
      return isExpanded
        ? <FolderOpen size={13} />
        : <Folder size={13} />;
    }
    return <FileCode2 size={13} />;
  }

  // ---- Render label (with inline rename) ----
  function renderLabel(node: SidebarTreeNode): ReactNode {
    if (renamingId === node.id) {
      return (
        <RenameInput
          initialName={node.label}
          onCommit={(name) => void handleRenameCommit(node.id, name)}
          onCancel={() => setRenamingId(null)}
        />
      );
    }
    if (searchQuery) {
      const needle = searchQuery.toLowerCase();
      const idx = node.label.toLowerCase().indexOf(needle);
      if (idx >= 0) {
        return (
          <>
            {node.label.slice(0, idx)}
            <span className={styles.searchMatch}>
              {node.label.slice(idx, idx + needle.length)}
            </span>
            {node.label.slice(idx + needle.length)}
          </>
        );
      }
    }
    return node.label;
  }

  // ---- Keyboard handler on the tree wrapper ----
  function handleTreeKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // F2 — rename focused node
    if (e.key === "F2" && contextTarget.node) {
      e.preventDefault();
      const prefix = contextTarget.kind === "folder" ? "folder:" : "query:";
      setRenamingId(`${prefix}${contextTarget.node.id}`);
      return;
    }
    // Delete / Backspace — delete focused node
    if ((e.key === "Delete" || e.key === "Backspace") && contextTarget.node) {
      e.preventDefault();
      requestDelete(contextTarget.kind as "folder" | "query", contextTarget.node.id);
    }
  }

  // ---- Collapse all ----
  function collapseAll() {
    setPersistedExpanded(new Set());
    schedulePersistedExpansionWrite(new Set());
  }

  // ---- Delete dialog copy ----
  function buildDeleteDialogContent(): { title: string; description: ReactNode } {
    if (!deleteTarget) return { title: "", description: null };
    if (deleteTarget.kind === "query") {
      return {
        title: "Delete query",
        description: (
          <>Delete query <strong>"{deleteTarget.name}"</strong>? This cannot be undone.</>
        ),
      };
    }
    if (deleteTarget.descendantCount === 0) {
      return {
        title: "Delete folder",
        description: (
          <>Delete folder <strong>"{deleteTarget.name}"</strong>? This cannot be undone.</>
        ),
      };
    }
    return {
      title: "Delete folder",
      description: (
        <>
          Delete folder <strong>"{deleteTarget.name}"</strong> and all{" "}
          <strong>{deleteTarget.descendantCount}</strong> items inside? This cannot be undone.
        </>
      ),
    };
  }

  const { title: deleteTitle, description: deleteDesc } = buildDeleteDialogContent();

  return (
    <section className={styles.panel}>
      {/* Header */}
      <header className={styles.header}>
        <span>Saved Queries</span>
        <span className={styles.headerActions}>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button className={styles.addButton} aria-label="New saved query or folder" title="New query or folder">
                <Plus size={14} strokeWidth={2.5} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className={styles.contextMenu} align="end">
                <DropdownMenu.Item
                  className={styles.contextItem}
                  onSelect={() => void handleCreateQuery(null)}
                >
                  New query
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={styles.contextItem}
                  onSelect={() => void handleCreateFolder(null)}
                >
                  New folder
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </span>
      </header>

      {/* Search */}
      <div className={styles.searchWrap}>
        <input
          {...noAutoCorrectProps}
          type="text"
          className={styles.searchInput}
          placeholder="Filter…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.stopPropagation(); setSearchQuery(""); }
          }}
          aria-label="Filter saved queries"
        />
      </div>

      {/* Tree */}
      <div className={styles.treeWrap}>
        {loading && <div className={styles.empty}>Loading…</div>}
        {error && <div className={styles.empty} style={{ color: "var(--danger)" }}>{error}</div>}
        {!loading && !error && (
          <ContextMenu.Root onOpenChange={handleContextMenuOpenChange}>
            <ContextMenu.Trigger asChild>
              {/* Wrapper captures right-click on the entire tree area */}
              <div
                onKeyDown={handleTreeKeyDown}
                onContextMenu={handleContextMenuCapture}
              >
                <SidebarTree
                  nodes={filteredNodes}
                  onActivate={onActivate}
                  onToggle={handleToggle}
                  renderIcon={renderIcon}
                  renderLabel={renderLabel}
                  isActivatable={(n) => {
                    const parsed = parseNodeId(n.id);
                    return parsed?.kind === "query";
                  }}
                  defaultExpanded={defaultExpandedSet}
                  forceExpanded={combinedForceExpanded}
                  ariaLabel="Saved queries"
                  empty={
                    searchQuery
                      ? "No matches."
                      : "No saved queries yet. Click + to create one."
                  }
                  scrollElementRef={sidebarScrollRef ?? undefined}
                  enableDnd
                  onDndDrop={(draggedId, drop) => void handleDndDrop(draggedId, drop)}
                  isDndDropAllowed={isDndDropAllowed}
                  isDropContainer={(n) => n.id.startsWith("folder:")}
                />
              </div>
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Content className={styles.contextMenu}>
                <SavedQueriesContextMenuItems
                  target={contextTarget}
                  onOpen={(id) => openSavedQuery(tabs, { items: connections }, id)}
                  onOpenInNewTab={(id) => openSavedQueryInNew(tabs, { items: connections }, id)}
                  onRename={(node) => {
                    const prefix = node.kind === "folder" ? "folder:" : "query:";
                    setRenamingId(`${prefix}${node.id}`);
                  }}
                  onDuplicate={(id) => void handleDuplicate(id)}
                  onMoveToFolder={(node) => {
                    if (node.kind !== "query") return;
                    setMoveTarget({
                      queryId: node.id,
                      queryName: node.name,
                      currentFolderId: node.folderId,
                    });
                  }}
                  onDelete={(node) => requestDelete(node.kind, node.id)}
                  onNewQuery={(folderId) => void handleCreateQuery(folderId)}
                  onNewFolder={(folderId) => void handleCreateFolder(folderId)}
                  onCollapseAll={collapseAll}
                />
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        )}
      </div>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title={deleteTitle}
        description={deleteDesc}
        confirmLabel="Delete"
        dangerous
        onConfirm={() => void handleDeleteConfirm()}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Move to folder */}
      <MoveToFolderDialog
        open={moveTarget !== null}
        queryName={moveTarget?.queryName ?? ""}
        folders={folders}
        currentFolderId={moveTarget?.currentFolderId ?? null}
        onConfirm={(targetFolderId) => {
          if (!moveTarget) return;
          void handleMoveQuery(moveTarget.queryId, targetFolderId);
          setMoveTarget(null);
        }}
        onCancel={() => setMoveTarget(null)}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Context menu items — extracted for clarity
// ---------------------------------------------------------------------------

interface ContextMenuItemsProps {
  target: ContextTarget;
  onOpen: (id: string) => void;
  onOpenInNewTab: (id: string) => void;
  onRename: (node: SqTreeNode) => void;
  onDuplicate: (id: string) => void;
  onMoveToFolder: (node: SqTreeNode) => void;
  onDelete: (node: SqTreeNode) => void;
  onNewQuery: (folderId: string | null | undefined) => void;
  onNewFolder: (folderId: string | null | undefined) => void;
  onCollapseAll: () => void;
}

function SavedQueriesContextMenuItems({
  target,
  onOpen,
  onOpenInNewTab,
  onRename,
  onDuplicate,
  onMoveToFolder,
  onDelete,
  onNewQuery,
  onNewFolder,
  onCollapseAll,
}: ContextMenuItemsProps) {
  if (target.kind === "query" && target.node) {
    const node = target.node as QueryNode;
    return (
      <>
        <ContextMenu.Item className={styles.contextItem} onSelect={() => onOpen(node.id)}>
          Open
        </ContextMenu.Item>
        <ContextMenu.Item className={styles.contextItem} onSelect={() => onOpenInNewTab(node.id)}>
          Open in new tab
        </ContextMenu.Item>
        <ContextMenu.Separator className={styles.contextSeparator} />
        <ContextMenu.Item className={styles.contextItem} onSelect={() => onRename(node)}>
          Rename <span style={{ color: "var(--text-subtle)", fontSize: 11 }}>F2</span>
        </ContextMenu.Item>
        <ContextMenu.Item className={styles.contextItem} onSelect={() => onDuplicate(node.id)}>
          Duplicate
        </ContextMenu.Item>
        <ContextMenu.Item className={styles.contextItem} onSelect={() => onMoveToFolder(node)}>
          Move to folder…
        </ContextMenu.Item>
        <ContextMenu.Separator className={styles.contextSeparator} />
        <ContextMenu.Item
          className={`${styles.contextItem} ${styles.contextItemDanger}`}
          onSelect={() => onDelete(node)}
        >
          Delete
        </ContextMenu.Item>
      </>
    );
  }

  if (target.kind === "folder" && target.node) {
    const node = target.node as FolderNode;
    return (
      <>
        <ContextMenu.Item className={styles.contextItem} onSelect={() => onNewQuery(node.id)}>
          New query
        </ContextMenu.Item>
        <ContextMenu.Item className={styles.contextItem} onSelect={() => onNewFolder(node.id)}>
          New folder
        </ContextMenu.Item>
        <ContextMenu.Separator className={styles.contextSeparator} />
        <ContextMenu.Item className={styles.contextItem} onSelect={() => onRename(node)}>
          Rename <span style={{ color: "var(--text-subtle)", fontSize: 11 }}>F2</span>
        </ContextMenu.Item>
        <ContextMenu.Separator className={styles.contextSeparator} />
        <ContextMenu.Item
          className={`${styles.contextItem} ${styles.contextItemDanger}`}
          onSelect={() => onDelete(node)}
        >
          Delete
        </ContextMenu.Item>
      </>
    );
  }

  // Root / empty area
  return (
    <>
      <ContextMenu.Item className={styles.contextItem} onSelect={() => onNewQuery(null)}>
        New query
      </ContextMenu.Item>
      <ContextMenu.Item className={styles.contextItem} onSelect={() => onNewFolder(null)}>
        New folder
      </ContextMenu.Item>
      <ContextMenu.Separator className={styles.contextSeparator} />
      <ContextMenu.Item className={styles.contextItem} onSelect={onCollapseAll}>
        Collapse all
      </ContextMenu.Item>
    </>
  );
}

