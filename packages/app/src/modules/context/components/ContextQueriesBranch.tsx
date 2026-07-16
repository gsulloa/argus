import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, Code2, FilePlus, Folder, FolderOpen, FolderPlus } from "lucide-react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Dialog from "@radix-ui/react-dialog";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useContextQueries } from "@/modules/context/hooks";
import { useContextFolderLink } from "@/modules/context/useContextFolderLink";
import { knownFolderUsedBy } from "@/modules/context/knownFolderDisplay";
import { NamePromptDialog } from "@/modules/saved-queries/NamePromptDialog";
import { contextApi } from "@/modules/context/api";
import { useToast } from "@/platform/toast";
import type { QueryListItem } from "@/modules/context/types";
import dialogStyles from "@/platform/shell/Dialog.module.css";
import styles from "./ContextQueriesBranch.module.css";

export interface ContextQueriesBranchProps {
  connectionId: string;
  connectionName: string;
  contextPath: string | null;
  engine: "postgres" | "mysql" | "mssql" | "dynamo" | "cloudwatch";
  /** Called when the user activates a query. */
  onActivate: (query: QueryListItem) => void;
  /**
   * Called when the user initiates "New query" from the branch header or a folder node.
   * Receives the chosen name and optional target folder; the caller (ConnectionRow) is
   * responsible for calling contextApi.saveQuery and opening the tab.
   */
  onNewQuery?: (name: string, folder?: string) => void;
  /**
   * Called after a context folder is successfully linked/created via the
   * setup CTA so that the parent (ConnectionRow via useConnections) can
   * refresh the connections list and re-render the branch with a path.
   */
  onFolderLinked?: () => void;
}

// ---------------------------------------------------------------------------
// Tree node types
// ---------------------------------------------------------------------------

interface FolderNode {
  kind: "folder";
  name: string;
  /** Full relative path of this folder, e.g. `"reports"` or `"reports/daily"`. */
  path: string;
  children: TreeNode[];
}

interface QueryNode {
  kind: "query";
  item: QueryListItem;
}

type TreeNode = FolderNode | QueryNode;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Return the last segment of a path (the "slug"). */
function slugOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/**
 * Join a folder path and a slug into a relative path.
 * If dest is "" (root) return the slug alone.
 */
function joinPath(dest: string, slug: string): string {
  return dest ? `${dest}/${slug}` : slug;
}

/**
 * Compute the destination `to_path` for moving `query` into folder `dest`
 * (keeping the query's existing slug). Returns `null` when the move is a
 * no-op — i.e. the query already lives in `dest` — so callers can skip the
 * backend `renameQuery` (which would otherwise reject with "already exists").
 */
export function moveTargetOrNoop(query: QueryListItem, dest: string): string | null {
  const to = joinPath(dest, slugOf(query.path));
  return to === query.path ? null : to;
}

/**
 * Convert a display name to a filesystem-safe slug, mirroring the backend rule:
 * replace each run of characters that are NOT [A-Za-z0-9_-] with a single "-",
 * then trim leading/trailing "-".
 */
export function slugify(name: string): string {
  return name
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Tree-building helpers
// ---------------------------------------------------------------------------

/**
 * Build a nested tree from a flat queries list + folders list.
 * Folders sort before queries at each level, each group sorted
 * case-insensitively by name.
 */
function buildTree(queries: QueryListItem[], folders: string[]): TreeNode[] {
  // Map from folder path -> FolderNode (populated lazily)
  const folderMap = new Map<string, FolderNode>();

  // Ensure a folder node exists for every segment of the path.
  function ensureFolder(folderPath: string): FolderNode {
    if (folderMap.has(folderPath)) {
      return folderMap.get(folderPath)!;
    }
    const segments = folderPath.split("/");
    const name = segments[segments.length - 1] ?? folderPath;
    const node: FolderNode = { kind: "folder", name, path: folderPath, children: [] };
    folderMap.set(folderPath, node);
    return node;
  }

  // Pre-create all known folder nodes (including empty ones)
  for (const f of folders) {
    if (f) ensureFolder(f);
  }

  // Ensure ancestor folders exist for each known folder
  for (const f of folders) {
    if (!f) continue;
    const segments = f.split("/");
    for (let i = 1; i < segments.length; i++) {
      ensureFolder(segments.slice(0, i).join("/"));
    }
  }

  // Attach query nodes to their parent folders (or root)
  const rootNodes: TreeNode[] = [];

  function getParentChildren(folderPath: string): TreeNode[] {
    if (!folderPath) return rootNodes;
    const node = ensureFolder(folderPath);
    // Ensure ancestor chain is wired (may already be done)
    const parentPath = folderPath.includes("/")
      ? folderPath.split("/").slice(0, -1).join("/")
      : "";
    const parentChildren = getParentChildren(parentPath);
    if (!parentChildren.includes(node)) {
      parentChildren.push(node);
    }
    return node.children;
  }

  // Wire EVERY known folder (root-level, nested, and empty) into its parent
  // chain. Without this, empty or nested folders that contain no direct query
  // are created in the map but never attached to their parent's `children`,
  // so they never render. Snapshot the keys since getParentChildren mutates
  // parent children (but not the map itself).
  for (const folderPath of [...folderMap.keys()]) {
    getParentChildren(folderPath);
  }

  for (const q of queries) {
    const children = getParentChildren(q.folder);
    children.push({ kind: "query", item: q });
  }

  // Recursively sort: folders before queries, case-insensitive by name
  function sortNodes(nodes: TreeNode[]): TreeNode[] {
    return nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      const nameA = a.kind === "folder" ? a.name : a.item.name;
      const nameB = b.kind === "folder" ? b.name : b.item.name;
      return nameA.toLowerCase().localeCompare(nameB.toLowerCase());
    });
  }

  function sortTree(nodes: TreeNode[]): TreeNode[] {
    sortNodes(nodes);
    for (const node of nodes) {
      if (node.kind === "folder") {
        sortTree(node.children);
      }
    }
    return nodes;
  }

  return sortTree(rootNodes);
}

// ---------------------------------------------------------------------------
// ConfirmDialog — local, mirrors SavedQueriesPanel's ConfirmDialog
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
            <button type="button" autoFocus onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
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
// MoveToFolderDialog — folder picker for query move
// ---------------------------------------------------------------------------

interface MoveToFolderDialogProps {
  open: boolean;
  queryName: string;
  /** All folder paths available in this connection (already excludes current). */
  availableFolders: string[];
  onConfirm: (dest: string) => void;
  onCancel: () => void;
}

function MoveToFolderDialog({
  open,
  queryName,
  availableFolders,
  onConfirm,
  onCancel,
}: MoveToFolderDialogProps) {
  const [selected, setSelected] = useState<string>("");

  useEffect(() => {
    if (open) setSelected("");
  }, [open]);

  const options: Array<{ value: string; label: string }> = [
    { value: "", label: "(root)" },
    ...availableFolders.map((f) => ({ value: f, label: f })),
  ];

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.overlay} />
        <Dialog.Content className={dialogStyles.content}>
          <Dialog.Title className={dialogStyles.title}>Move to folder</Dialog.Title>
          <Dialog.Description className={dialogStyles.description}>
            Choose a destination for <strong>{queryName}</strong>.
          </Dialog.Description>
          <div className={styles.folderPickerList}>
            {options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`${styles.folderPickerItem} ${selected === opt.value ? styles.folderPickerItemSelected : ""}`}
                onClick={() => setSelected(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className={dialogStyles.footer}>
            <button type="button" onClick={onCancel}>Cancel</button>
            <button
              type="button"
              className={dialogStyles.primary}
              onClick={() => onConfirm(selected)}
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
// Pending action state for dialogs at the tree level
// ---------------------------------------------------------------------------

interface PendingMove {
  kind: "move";
  query: QueryListItem;
}
interface PendingRename {
  kind: "rename";
  query: QueryListItem;
}
interface PendingDelete {
  kind: "delete";
  query: QueryListItem;
}
interface PendingDeleteFolder {
  kind: "deleteFolder";
  folderPath: string;
  folderName: string;
}

type PendingAction = PendingMove | PendingRename | PendingDelete | PendingDeleteFolder;

// ---------------------------------------------------------------------------
// Shared handlers object threaded down the tree
// ---------------------------------------------------------------------------

interface BranchHandlers {
  connectionId: string;
  allFolders: string[];
  onActivate: (query: QueryListItem) => void;
  onNewQuery?: (name: string, folder?: string) => void;
  onRefreshNeeded: () => void;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  targetFolder: string | null;
  onSetTargetFolder: (path: string | null) => void;
  onPendingAction: (action: PendingAction) => void;
  /**
   * Folder path currently hovered as a drop target (pointer DnD, "" = root),
   * used to render the drop highlight. Null when nothing is hovered.
   */
  dragOverPath: string | null;
}

// ---------------------------------------------------------------------------
// Query row — draggable (pointer DnD via @dnd-kit)
// ---------------------------------------------------------------------------

interface QueryRowProps {
  item: QueryListItem;
  indentPx: number;
  onActivate: (query: QueryListItem) => void;
  onPendingAction: (action: PendingAction) => void;
}

function QueryRow({ item, indentPx, onActivate, onPendingAction }: QueryRowProps) {
  // The query's path is the stable, unique drag id. `data.query` is read back
  // in the branch-level drag handlers to resolve the move.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `q:${item.path}`,
    data: { query: item },
  });

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <button
          ref={setNodeRef}
          type="button"
          className={styles.queryRow}
          style={{ paddingLeft: indentPx, opacity: isDragging ? 0.4 : undefined }}
          title={item.description ?? item.name}
          onClick={() => onActivate(item)}
          {...listeners}
          {...attributes}
        >
          <span className={styles.queryIcon}>
            <Code2 size={12} strokeWidth={1.5} />
          </span>
          <span className={styles.queryName}>{item.name}</span>
        </button>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={styles.contextMenu}>
          <ContextMenu.Item
            className={styles.contextItem}
            onSelect={() => onActivate(item)}
          >
            Open
          </ContextMenu.Item>
          <ContextMenu.Separator className={styles.contextSeparator} />
          <ContextMenu.Item
            className={styles.contextItem}
            onSelect={() => onPendingAction({ kind: "move", query: item })}
          >
            Move to folder…
          </ContextMenu.Item>
          <ContextMenu.Item
            className={styles.contextItem}
            onSelect={() => onPendingAction({ kind: "rename", query: item })}
          >
            Rename
          </ContextMenu.Item>
          <ContextMenu.Separator className={styles.contextSeparator} />
          <ContextMenu.Item
            className={`${styles.contextItem} ${styles.contextItemDanger}`}
            onSelect={() => onPendingAction({ kind: "delete", query: item })}
          >
            Delete
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

// ---------------------------------------------------------------------------
// Folder row — drop target (pointer DnD via @dnd-kit)
// ---------------------------------------------------------------------------

interface FolderRowProps {
  node: FolderNode;
  depth: number;
  indentPx: number;
  handlers: BranchHandlers;
}

function FolderRow({ node, depth, indentPx, handlers }: FolderRowProps) {
  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false);
  const [showNewQueryDialog, setShowNewQueryDialog] = useState(false);

  const {
    connectionId,
    onNewQuery,
    onRefreshNeeded,
    expandedFolders,
    onToggleFolder,
    targetFolder,
    onSetTargetFolder,
    onPendingAction,
    dragOverPath,
  } = handlers;

  // The folder is a drop target; `data.dest` is the destination folder path.
  const { setNodeRef } = useDroppable({ id: `f:${node.path}`, data: { dest: node.path } });

  const isExpanded = expandedFolders.has(node.path);
  const isTarget = targetFolder === node.path;
  const isDropTarget = dragOverPath === node.path;
  const FolderIcon = isExpanded ? FolderOpen : Folder;

  return (
    <div className={styles.folderGroup}>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            ref={setNodeRef}
            className={`${styles.folderRow} ${isTarget ? styles.folderRowTarget : ""} ${isDropTarget ? styles.folderRowDropTarget : ""}`}
            style={{ paddingLeft: indentPx - 4 }}
          >
            <button
              type="button"
              className={styles.folderBtn}
              title={node.path}
              onClick={() => {
                onToggleFolder(node.path);
                onSetTargetFolder(isTarget ? null : node.path);
              }}
              aria-expanded={isExpanded}
            >
              <span className={styles.folderCaret} data-expanded={String(isExpanded)}>
                <ChevronRight size={10} strokeWidth={2} />
              </span>
              <span className={styles.folderIcon}>
                <FolderIcon size={12} strokeWidth={1.5} />
              </span>
              <span className={styles.folderName}>{node.name}</span>
            </button>
            <div className={styles.folderActions}>
              {onNewQuery && (
                <button
                  type="button"
                  className={styles.folderActionBtn}
                  title="New query in this folder"
                  aria-label="New query in folder"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowNewQueryDialog(true);
                  }}
                >
                  <FilePlus size={11} strokeWidth={1.5} />
                </button>
              )}
              <button
                type="button"
                className={styles.folderActionBtn}
                title="New subfolder"
                aria-label="New subfolder"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowNewFolderDialog(true);
                }}
              >
                <FolderPlus size={11} strokeWidth={1.5} />
              </button>
            </div>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={styles.contextMenu}>
            {onNewQuery && (
              <ContextMenu.Item
                className={styles.contextItem}
                onSelect={() => setShowNewQueryDialog(true)}
              >
                New query
              </ContextMenu.Item>
            )}
            <ContextMenu.Item
              className={styles.contextItem}
              onSelect={() => setShowNewFolderDialog(true)}
            >
              New subfolder
            </ContextMenu.Item>
            <ContextMenu.Separator className={styles.contextSeparator} />
            <ContextMenu.Item
              className={`${styles.contextItem} ${styles.contextItemDanger}`}
              onSelect={() =>
                onPendingAction({
                  kind: "deleteFolder",
                  folderPath: node.path,
                  folderName: node.name,
                })
              }
            >
              Delete folder
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      {isExpanded && (
        <div className={styles.folderChildren}>
          <QueryTree nodes={node.children} depth={depth + 1} handlers={handlers} />
        </div>
      )}

      {/* New folder dialog for this sub-level */}
      <NamePromptDialog
        open={showNewFolderDialog}
        title="New folder"
        placeholder="folder-name"
        onConfirm={(name) => {
          setShowNewFolderDialog(false);
          const fullPath = `${node.path}/${name}`;
          void contextApi
            .createQueryFolder(connectionId, fullPath)
            .then(() => onRefreshNeeded())
            .catch(console.error);
        }}
        onCancel={() => setShowNewFolderDialog(false)}
      />

      {/* New query dialog for this sub-level */}
      <NamePromptDialog
        open={showNewQueryDialog}
        title="New context query"
        placeholder="Query name"
        onConfirm={(name) => {
          setShowNewQueryDialog(false);
          onNewQuery?.(name, node.path);
        }}
        onCancel={() => setShowNewQueryDialog(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recursive tree renderer — dispatches to QueryRow / FolderRow
// ---------------------------------------------------------------------------

interface QueryTreeProps {
  nodes: TreeNode[];
  depth: number;
  handlers: BranchHandlers;
}

function QueryTree({ nodes, depth, handlers }: QueryTreeProps) {
  const indentPx = 18 + depth * 10;
  return (
    <>
      {nodes.map((node) =>
        node.kind === "query" ? (
          <QueryRow
            key={node.item.path}
            item={node.item}
            indentPx={indentPx}
            onActivate={handlers.onActivate}
            onPendingAction={handlers.onPendingAction}
          />
        ) : (
          <FolderRow
            key={node.path}
            node={node}
            depth={depth}
            indentPx={indentPx}
            handlers={handlers}
          />
        ),
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Branch body — the root drop target (drop here → move to top level)
// ---------------------------------------------------------------------------

function BranchBody({
  dragOverPath,
  children,
}: {
  dragOverPath: string | null;
  children: ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id: "root", data: { dest: "" } });
  return (
    <div
      ref={setNodeRef}
      className={`${styles.body} ${dragOverPath === "" ? styles.bodyDropTarget : ""}`}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Sidebar branch that renders the nested folder tree of context-folder prefab
 * queries under a connection node.
 *
 * Three states:
 *  1. `contextPath` is null → render a compact setup CTA
 *  2. `contextPath` is set, queries list is empty and no folders → render header + New query hint
 *  3. `contextPath` is set, queries and/or folders exist → render nested tree
 */
export function ContextQueriesBranch({
  connectionId,
  contextPath,
  onActivate,
  onNewQuery,
  onFolderLinked,
}: ContextQueriesBranchProps): JSX.Element | null {
  const { data: listResult, loading, error, refresh } = useContextQueries(connectionId, contextPath);
  const { queries, folders } = listResult;
  const toast = useToast();

  // Default: expanded when ≤ 8 queries, collapsed otherwise.
  const [expanded, setExpanded] = useState<boolean | null>(null);

  // Track expanded folder paths
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  // Track the "target" folder for New query / New folder actions
  const [targetFolder, setTargetFolder] = useState<string | null>(null);

  // New query prompt dialog state (root-level)
  const [showNewQueryDialog, setShowNewQueryDialog] = useState(false);

  // New folder prompt dialog state (root-level)
  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false);

  // Pending action state (drives dialogs at branch level)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);

  // Drag-and-drop move state (pointer DnD via @dnd-kit — HTML5 native DnD is
  // swallowed by the Tauri webview, so we mirror the SidebarTree approach).
  // `draggingQuery` drives the drag ghost; `dragOverPath` is the folder path
  // (or "" for root) currently highlighted as a drop target.
  const [draggingQuery, setDraggingQuery] = useState<QueryListItem | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);

  // A small activation distance keeps row clicks working — a drag only begins
  // once the pointer moves ≥5px.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // Resolve effective expansion: if user hasn't toggled, use the default rule.
  const effectiveExpanded =
    expanded !== null ? expanded : queries.length <= 8;

  // Setup CTA state — only active when contextPath is null
  const onFolderLinkedCallback = onFolderLinked ?? (() => undefined);
  const {
    knownFolders,
    knownFoldersLoading,
    busy: ctaBusy,
    error: ctaError,
    reuse,
    beginCreate,
    confirmCreate,
    chooseExisting,
  } = useContextFolderLink(connectionId, onFolderLinkedCallback);

  // New folder name prompt (for the create-new flow in setup CTA)
  const [showFolderNameDialog, setShowFolderNameDialog] = useState(false);

  function handleToggleFolder(path: string) {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  // ---- Action handlers triggered from context menus ----

  async function handleMove(query: QueryListItem, dest: string) {
    const newPath = moveTargetOrNoop(query, dest);
    if (newPath === null) {
      // No-op move (dest === current folder) — skip the backend call so it
      // doesn't error with "already exists".
      setPendingAction(null);
      return;
    }
    try {
      await contextApi.renameQuery(connectionId, query.path, newPath);
      refresh();
    } catch (e) {
      toast.show(`Move failed: ${(e as Error).message}`, "error");
    }
    setPendingAction(null);
  }

  // ---- Drag-and-drop (pointer DnD) ----

  function handleDragStart(event: DragStartEvent) {
    const query = event.active.data.current?.query as QueryListItem | undefined;
    setDraggingQuery(query ?? null);
    setDragOverPath(null);
  }

  function handleDragOver(event: DragOverEvent) {
    const dest = event.over?.data.current?.dest as string | undefined;
    // `dest` is "" for the root drop zone and a path for a folder; undefined
    // when hovering nothing droppable.
    setDragOverPath(dest ?? null);
  }

  async function handleDragEnd(event: DragEndEvent) {
    const query = event.active.data.current?.query as QueryListItem | undefined;
    const dest = event.over?.data.current?.dest as string | undefined;
    setDraggingQuery(null);
    setDragOverPath(null);
    if (!query || dest === undefined) return; // dropped outside any target
    const newPath = moveTargetOrNoop(query, dest);
    if (newPath === null) return; // no-op: already in this folder
    try {
      await contextApi.renameQuery(connectionId, query.path, newPath);
      // Auto-expand the destination folder so the moved query is visible.
      if (dest) {
        setExpandedFolders((prev) => new Set(prev).add(dest));
      }
      refresh();
    } catch (e) {
      toast.show(`Move failed: ${(e as Error).message}`, "error");
    }
  }

  function handleDragCancel() {
    setDraggingQuery(null);
    setDragOverPath(null);
  }

  async function handleRename(query: QueryListItem, newName: string) {
    const slug = slugify(newName);
    if (!slug) {
      toast.show("Name cannot produce a valid slug.", "error");
      return;
    }
    const newPath = joinPath(query.folder, slug);
    try {
      await contextApi.renameQuery(connectionId, query.path, newPath);
      refresh();
    } catch (e) {
      toast.show(`Rename failed: ${(e as Error).message}`, "error");
    }
    setPendingAction(null);
  }

  async function handleDeleteQuery(query: QueryListItem) {
    try {
      await contextApi.deleteQuery(connectionId, query.path);
      refresh();
    } catch (e) {
      toast.show(`Delete failed: ${(e as Error).message}`, "error");
    }
    setPendingAction(null);
  }

  async function handleDeleteFolder(folderPath: string) {
    try {
      await contextApi.deleteQueryFolder(connectionId, folderPath);
      refresh();
    } catch (e) {
      toast.show(`Delete folder failed: ${(e as Error).message}`, "error");
    }
    setPendingAction(null);
  }

  // Guard 1: no linked folder — render setup CTA
  if (!contextPath) {
    return (
      <div className={styles.root}>
        <div className={styles.ctaHeader}>
          <span className={styles.label}>Context Queries</span>
        </div>
        <div className={styles.ctaBody}>
          {knownFoldersLoading && (
            <p className={styles.ctaHint}>Loading folders…</p>
          )}
          {!knownFoldersLoading && knownFolders != null && knownFolders.length > 0 && (
            <div className={styles.ctaKnownList}>
              {knownFolders.map((folder) => {
                const usedBy = knownFolderUsedBy(folder.connections);
                return (
                  <button
                    key={folder.path}
                    type="button"
                    className={styles.ctaKnownItem}
                    disabled={ctaBusy}
                    onClick={() => void reuse(folder.path)}
                    title={folder.path}
                  >
                    <span className={styles.ctaKnownMain}>
                      <Folder size={11} className={styles.ctaFolderIcon} />
                      <span className={styles.ctaKnownName}>{folder.name}</span>
                      <span className={styles.ctaKnownPath}>{folder.path}</span>
                    </span>
                    {usedBy && (
                      <span className={styles.ctaKnownUsedBy}>
                        Used by {usedBy.text}
                        {usedBy.overflow > 0 && ` +${usedBy.overflow} more`}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          <div className={styles.ctaBtnGroup}>
            <button
              type="button"
              className={styles.ctaBtn}
              disabled={ctaBusy}
              onClick={() => void beginCreate().then(() => setShowFolderNameDialog(true))}
            >
              {(!knownFolders || knownFolders.length === 0) ? "Create folder…" : "New folder…"}
            </button>
            <button
              type="button"
              className={styles.ctaBtn}
              disabled={ctaBusy}
              onClick={() => void chooseExisting()}
            >
              {(!knownFolders || knownFolders.length === 0) ? "Link existing…" : "Choose other…"}
            </button>
          </div>
          {ctaError && (
            <div className={styles.ctaError}>{ctaError}</div>
          )}
        </div>

        {/* Folder name dialog for create-new flow */}
        <NamePromptDialog
          open={showFolderNameDialog}
          title="New context folder name"
          placeholder="argus-context"
          onConfirm={(name) => {
            setShowFolderNameDialog(false);
            void confirmCreate(name);
          }}
          onCancel={() => setShowFolderNameDialog(false)}
        />
      </div>
    );
  }

  const tree = buildTree(queries, folders);
  const totalCount = queries.length;

  const branchHandlers: BranchHandlers = {
    connectionId,
    allFolders: folders,
    onActivate,
    onNewQuery,
    onRefreshNeeded: refresh,
    expandedFolders,
    onToggleFolder: handleToggleFolder,
    targetFolder,
    onSetTargetFolder: setTargetFolder,
    onPendingAction: setPendingAction,
    dragOverPath,
  };

  // Compute available move destinations (all folders, excluding the query's current folder)
  const moveQuery = pendingAction?.kind === "move" ? pendingAction.query : null;
  const moveFolders = moveQuery
    ? folders.filter((f) => f !== moveQuery.folder)
    : [];

  return (
    <div className={styles.root}>
      <div className={styles.headerRow}>
        <button
          type="button"
          className={styles.header}
          onClick={() => setExpanded(!effectiveExpanded)}
          aria-expanded={effectiveExpanded}
        >
          <span className={styles.caret} data-expanded={String(effectiveExpanded)}>
            <ChevronRight size={11} strokeWidth={2} />
          </span>
          <span className={styles.label}>Context Queries</span>
          {totalCount > 0 && (
            <span className={styles.count}>{totalCount}</span>
          )}
        </button>
        <div className={styles.headerActions}>
          {onNewQuery && (
            <button
              type="button"
              className={styles.newQueryBtn}
              title="New context query"
              aria-label="New context query"
              onClick={() => setShowNewQueryDialog(true)}
            >
              <FilePlus size={12} strokeWidth={1.5} />
            </button>
          )}
          <button
            type="button"
            className={styles.newQueryBtn}
            title="New folder"
            aria-label="New folder"
            onClick={() => setShowNewFolderDialog(true)}
          >
            <FolderPlus size={12} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {effectiveExpanded && (
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <BranchBody dragOverPath={dragOverPath}>
            {loading && queries.length === 0 && folders.length === 0 && (
              <div className={styles.skeleton}>
                <div className={styles.skeletonLine} style={{ width: "70%" }} />
                <div className={styles.skeletonLine} style={{ width: "55%" }} />
              </div>
            )}
            {error && (
              <div className={styles.error}>{error.message}</div>
            )}
            {!loading && !error && queries.length === 0 && folders.length === 0 && (
              <div className={styles.emptyHint}>No queries yet.</div>
            )}
            <QueryTree nodes={tree} depth={0} handlers={branchHandlers} />
          </BranchBody>
          <DragOverlay dropAnimation={null}>
            {draggingQuery ? (
              <div className={styles.queryRow} style={{ paddingLeft: 18 }}>
                <span className={styles.queryIcon}>
                  <Code2 size={12} strokeWidth={1.5} />
                </span>
                <span className={styles.queryName}>{draggingQuery.name}</span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {/* Root-level New query name prompt */}
      <NamePromptDialog
        open={showNewQueryDialog}
        title="New context query"
        placeholder="Query name"
        onConfirm={(name) => {
          setShowNewQueryDialog(false);
          onNewQuery?.(name, targetFolder ?? undefined);
        }}
        onCancel={() => setShowNewQueryDialog(false)}
      />

      {/* Root-level New folder prompt */}
      <NamePromptDialog
        open={showNewFolderDialog}
        title="New folder"
        placeholder="folder-name"
        onConfirm={(name) => {
          setShowNewFolderDialog(false);
          const fullPath = targetFolder ? `${targetFolder}/${name}` : name;
          void contextApi
            .createQueryFolder(connectionId, fullPath)
            .then(() => refresh())
            .catch(console.error);
        }}
        onCancel={() => setShowNewFolderDialog(false)}
      />

      {/* Move to folder dialog */}
      <MoveToFolderDialog
        open={pendingAction?.kind === "move"}
        queryName={moveQuery?.name ?? ""}
        availableFolders={moveFolders}
        onConfirm={(dest) => {
          if (moveQuery) void handleMove(moveQuery, dest);
        }}
        onCancel={() => setPendingAction(null)}
      />

      {/* Rename dialog */}
      <NamePromptDialog
        open={pendingAction?.kind === "rename"}
        title="Rename query"
        placeholder="New name"
        confirmLabel="Rename"
        initialValue={pendingAction?.kind === "rename" ? pendingAction.query.name : ""}
        onConfirm={(newName) => {
          if (pendingAction?.kind === "rename") void handleRename(pendingAction.query, newName);
        }}
        onCancel={() => setPendingAction(null)}
      />

      {/* Delete query confirm */}
      <ConfirmDialog
        open={pendingAction?.kind === "delete"}
        title="Delete query"
        description={
          pendingAction?.kind === "delete" ? (
            <>Delete query <strong>"{pendingAction.query.name}"</strong>? This cannot be undone.</>
          ) : null
        }
        confirmLabel="Delete"
        dangerous
        onConfirm={() => {
          if (pendingAction?.kind === "delete") void handleDeleteQuery(pendingAction.query);
        }}
        onCancel={() => setPendingAction(null)}
      />

      {/* Delete folder confirm */}
      <ConfirmDialog
        open={pendingAction?.kind === "deleteFolder"}
        title="Delete folder"
        description={
          pendingAction?.kind === "deleteFolder" ? (
            <>Delete folder <strong>"{pendingAction.folderName}"</strong>? This cannot be undone.</>
          ) : null
        }
        confirmLabel="Delete"
        dangerous
        onConfirm={() => {
          if (pendingAction?.kind === "deleteFolder")
            void handleDeleteFolder(pendingAction.folderPath);
        }}
        onCancel={() => setPendingAction(null)}
      />
    </div>
  );
}
