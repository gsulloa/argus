import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ChevronRight } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import styles from "./SidebarTree.module.css";

export interface TreeNode {
  /** Stable id, unique within the tree. */
  id: string;
  /** Human label rendered in the row. */
  label: string;
  /** Indent level — 0 is the root. */
  level: number;
  /** True when this node has children (renders a caret). */
  hasChildren: boolean;
  /** Children (only populated for `hasChildren`). */
  children?: TreeNode[];
  /** Arbitrary payload returned via callbacks. */
  data?: unknown;
}

export interface SidebarTreeHandle {
  /** Imperatively set the focused node by id. */
  focusNode(id: string): void;
  /** Imperatively expand a node. */
  expand(id: string): void;
  /** Imperatively collapse a node. */
  collapse(id: string): void;
}

// ---------------------------------------------------------------------------
// DnD types
// ---------------------------------------------------------------------------

export type DndDropResult =
  | { type: "into"; targetId: string }         // drop onto a folder → move into
  | { type: "before"; targetId: string }       // drop between rows → insert before target
  | { type: "after"; targetId: string }        // drop between rows → insert after target
  | { type: "root" };                          // drop on root area

export interface SidebarTreeDndProps {
  /**
   * When true, rows become draggable and drop targets are activated.
   * When false (default), the tree behaves exactly as before — no DnD code runs.
   */
  enableDnd?: boolean;
  /** Called on drag end with the dragged node id and resolved drop target. */
  onDndDrop?: (draggedId: string, drop: DndDropResult) => void;
  /**
   * Called during drag-over to determine if a node is a valid drop target
   * (folder-to-descendant validation, etc.). Return false to reject.
   */
  isDndDropAllowed?: (draggedId: string, overId: string) => boolean;
  /**
   * Whether a node accepts "into" drops (i.e. is a container/folder).
   * Defaults to `node.hasChildren`, but that misses EMPTY folders — consumers
   * with domain knowledge (e.g. "any node whose id starts with `folder:`")
   * should override.
   */
  isDropContainer?: (node: TreeNode) => boolean;
}

export interface SidebarTreeProps extends SidebarTreeDndProps {
  nodes: TreeNode[];
  onActivate: (node: TreeNode) => void;
  /** Optional leading icon. */
  renderIcon?: (node: TreeNode) => ReactNode;
  /** Optional trailing badge (e.g. "FDW", item counts). */
  renderBadge?: (node: TreeNode) => ReactNode;
  /** Optional label decorator (e.g. for highlighting search matches). */
  renderLabel?: (node: TreeNode) => ReactNode;
  /** Default 500. Above the threshold the scroller virtualizes. */
  virtualizationThreshold?: number;
  /** IDs that should start expanded. */
  defaultExpanded?: Set<string>;
  /** IDs that MUST be expanded (e.g. ancestors of a search match). */
  forceExpanded?: Set<string>;
  /** Empty-state content. */
  empty?: ReactNode;
  ariaLabel?: string;
  className?: string;
  /** Approximate row height in px (used by the virtualizer). */
  rowHeight?: number;
  /**
   * Whether a node should be treated as activatable on row click / Enter.
   * Defaults to "leaves only" (`!node.hasChildren`). Consumers can opt in
   * activatable-with-children nodes (e.g. a table that activates on click
   * but still expands its indexes/triggers via the caret).
   */
  isActivatable?: (node: TreeNode) => boolean;
  /**
   * Optional callback fired whenever a node's expansion state toggles. Used by
   * consumers that need to lazy-load children on first expand. Fires after the
   * tree's internal state has been updated; receives the new state.
   */
  onToggle?: (node: TreeNode, expanded: boolean) => void;
  /**
   * Optional ref to an external scroll element. When provided, the virtualizer
   * measures rows against it instead of the tree's own internal scroller —
   * letting the tree contribute to a larger shared scroll context (e.g. the
   * sidebar). When omitted, the tree falls back to its internal scroller.
   */
  scrollElementRef?: RefObject<HTMLElement | null>;
}

interface FlatNode {
  node: TreeNode;
  expanded: boolean;
}

function flatten(
  nodes: TreeNode[],
  isExpanded: (id: string) => boolean,
  out: FlatNode[],
) {
  for (const node of nodes) {
    out.push({ node, expanded: node.hasChildren && isExpanded(node.id) });
    if (node.hasChildren && node.children && isExpanded(node.id)) {
      flatten(node.children, isExpanded, out);
    }
  }
}

const TYPE_AHEAD_TIMEOUT_MS = 500;
const DEFAULT_VIRT_THRESHOLD = 500;
const DEFAULT_ROW_HEIGHT = 24;

// ---------------------------------------------------------------------------
// DnD row components — only rendered when enableDnd=true
// These must be separate components so they can call hooks unconditionally.
// ---------------------------------------------------------------------------

interface DraggableRowProps {
  flatNode: FlatNode;
  index: number;
  total: number;
  focusedId: string | null;
  isDropTarget: boolean;     // this row is the current drop target
  dropPosition: "into" | "before" | "after" | null;
  style?: CSSProperties;
  onRowClick: (flatNode: FlatNode) => void;
  onCaretClick: (e: MouseEvent<HTMLButtonElement>, id: string) => void;
  renderIcon?: (node: TreeNode) => ReactNode;
  renderBadge?: (node: TreeNode) => ReactNode;
  renderLabel?: (node: TreeNode) => ReactNode;
}

function DraggableRow({
  flatNode,
  index,
  total,
  focusedId,
  isDropTarget,
  dropPosition,
  style,
  onRowClick,
  onCaretClick,
  renderIcon,
  renderBadge,
  renderLabel,
}: DraggableRowProps) {
  const node = flatNode.node;
  const focused = node.id === focusedId;
  const indent = node.level * 12;

  // Draggable hook — each node is draggable
  const {
    attributes: rawAttributes,
    listeners,
    setNodeRef: setDragRef,
    transform,
    isDragging: isDraggingLocal,
  } = useDraggable({ id: node.id });
  // Override role from dnd-kit attributes so our treeitem role is preserved.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { role: _roleIgnored, ...attributes } = rawAttributes ?? {};

  // Droppable hook — each node can be a drop target
  const { setNodeRef: setDropRef } = useDroppable({ id: node.id });

  // Combine refs
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      setDragRef(el);
      setDropRef(el);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const dragStyle: CSSProperties = isDraggingLocal
    ? { opacity: 0.4 }
    : transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : {};

  const showDropBefore = isDropTarget && dropPosition === "before";
  const showDropAfter = isDropTarget && dropPosition === "after";
  const showDropInto = isDropTarget && dropPosition === "into";

  return (
    <div
      ref={setRef}
      role="treeitem"
      aria-level={node.level + 1}
      aria-expanded={node.hasChildren ? flatNode.expanded : undefined}
      aria-selected={focused}
      aria-posinset={index + 1}
      aria-setsize={total}
      data-focused={focused ? "true" : "false"}
      data-drop-into={showDropInto ? "true" : undefined}
      className={styles.row}
      style={{
        ...style,
        ...dragStyle,
        paddingInlineStart: 6 + indent,
        position: style?.position ?? "relative",
      }}
      onClick={() => onRowClick(flatNode)}
      title={node.label}
      {...listeners}
      {...attributes}
    >
      {/* Drop-before indicator */}
      {showDropBefore && (
        <div className={styles.dropIndicator} style={{ top: -1 }} />
      )}

      {node.hasChildren ? (
        <button
          type="button"
          aria-label={flatNode.expanded ? "Collapse" : "Expand"}
          tabIndex={-1}
          className={styles.caret}
          onClick={(e) => onCaretClick(e, node.id)}
          style={{
            transform: flatNode.expanded ? "rotate(90deg)" : "none",
            transition: "transform 100ms",
          }}
        >
          <ChevronRight size={12} />
        </button>
      ) : (
        <span className={styles.caretSpacer} aria-hidden />
      )}
      {renderIcon && <span className={styles.icon}>{renderIcon(node)}</span>}
      <span className={styles.label}>{renderLabel ? renderLabel(node) : node.label}</span>
      {renderBadge && <span className={styles.badge}>{renderBadge(node)}</span>}

      {/* Drop-after indicator */}
      {showDropAfter && (
        <div className={styles.dropIndicator} style={{ bottom: -1 }} />
      )}
    </div>
  );
}

// Ghost preview shown in DragOverlay
function DragGhost({
  node,
  renderIcon,
  renderLabel,
}: {
  node: TreeNode;
  renderIcon?: (node: TreeNode) => ReactNode;
  renderLabel?: (node: TreeNode) => ReactNode;
}) {
  return (
    <div className={`${styles.row} ${styles.dragGhost}`} style={{ paddingInlineStart: 6 }}>
      {renderIcon && <span className={styles.icon}>{renderIcon(node)}</span>}
      <span className={styles.label}>{renderLabel ? renderLabel(node) : node.label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main SidebarTree component
// ---------------------------------------------------------------------------

export const SidebarTree = forwardRef<SidebarTreeHandle, SidebarTreeProps>(function SidebarTree(
  {
    nodes,
    onActivate,
    renderIcon,
    renderBadge,
    renderLabel,
    virtualizationThreshold = DEFAULT_VIRT_THRESHOLD,
    defaultExpanded,
    forceExpanded,
    empty,
    ariaLabel,
    className,
    rowHeight = DEFAULT_ROW_HEIGHT,
    isActivatable,
    onToggle,
    scrollElementRef,
    // DnD props
    enableDnd = false,
    onDndDrop,
    isDndDropAllowed,
    isDropContainer,
  },
  ref,
) {
  const canActivate = useCallback(
    (node: TreeNode) =>
      isActivatable ? isActivatable(node) : !node.hasChildren,
    [isActivatable],
  );
  const onToggleRef = useRef(onToggle);
  onToggleRef.current = onToggle;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(defaultExpanded ?? []));
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const typeAhead = useRef<{ buffer: string; lastAt: number }>({ buffer: "", lastAt: 0 });

  // DnD state
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // "dropPosition" determines how the dragged item relates to the over-item.
  // We mirror it in a ref so that handleDragEnd reads the latest value
  // synchronously — dnd-kit fires onDragEnd before React commits the state
  // change from the last onDragOver, so reading from the state closure would
  // give us the stale (pre-final-move) position.
  const [dropPosition, setDropPosition] = useState<"into" | "before" | "after" | null>(null);
  const dropPositionRef = useRef<"into" | "before" | "after" | null>(null);
  const overIdRef = useRef<string | null>(null);
  // Track live pointer Y during drag — dnd-kit's DragOverEvent does not expose
  // the current pointer directly, and (activator.clientY + delta.y) drifts.
  const pointerYRef = useRef<number | null>(null);
  useEffect(() => {
    if (!enableDnd) return;
    function onMove(e: PointerEvent) { pointerYRef.current = e.clientY; }
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [enableDnd]);

  const isExpanded = useCallback(
    (id: string) => expanded.has(id) || (forceExpanded?.has(id) ?? false),
    [expanded, forceExpanded],
  );

  const flat = useMemo(() => {
    const out: FlatNode[] = [];
    flatten(nodes, isExpanded, out);
    return out;
  }, [nodes, isExpanded]);

  // Build a flat id → node map for `onToggle` callbacks. Walks the full tree
  // (not just expanded subtree) so deep collapses can still resolve the node.
  const nodeIndex = useMemo(() => {
    const map = new Map<string, TreeNode>();
    function walk(ns: TreeNode[]) {
      for (const n of ns) {
        map.set(n.id, n);
        if (n.children) walk(n.children);
      }
    }
    walk(nodes);
    return map;
  }, [nodes]);

  // When the focused id no longer exists in the visible flat list, reset to the first.
  useEffect(() => {
    if (focusedId && !flat.some((f) => f.node.id === focusedId)) {
      setFocusedId(flat[0]?.node.id ?? null);
    } else if (!focusedId && flat.length > 0) {
      setFocusedId(flat[0]?.node.id ?? null);
    }
  }, [flat, focusedId]);

  const focusedIndex = useMemo(() => {
    if (!focusedId) return -1;
    return flat.findIndex((f) => f.node.id === focusedId);
  }, [flat, focusedId]);

  const moveFocus = useCallback(
    (delta: number) => {
      if (flat.length === 0) return;
      const next = Math.min(Math.max(0, focusedIndex + delta), flat.length - 1);
      const target = flat[next];
      if (target) setFocusedId(target.node.id);
    },
    [flat, focusedIndex],
  );

  const setFocusByIndex = useCallback(
    (index: number) => {
      if (flat.length === 0) return;
      const i = Math.min(Math.max(0, index), flat.length - 1);
      const target = flat[i];
      if (target) setFocusedId(target.node.id);
    },
    [flat],
  );

  const fireToggle = useCallback(
    (id: string, expanded: boolean) => {
      const cb = onToggleRef.current;
      if (!cb) return;
      const node = nodeIndex.get(id);
      if (node) cb(node, expanded);
    },
    [nodeIndex],
  );

  const expandNode = useCallback(
    (id: string) => {
      let didExpand = false;
      setExpanded((prev) => {
        if (prev.has(id)) return prev;
        didExpand = true;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      if (didExpand) fireToggle(id, true);
    },
    [fireToggle],
  );

  const collapseNode = useCallback(
    (id: string) => {
      let didCollapse = false;
      setExpanded((prev) => {
        if (!prev.has(id)) return prev;
        didCollapse = true;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (didCollapse) fireToggle(id, false);
    },
    [fireToggle],
  );

  const toggleNode = useCallback(
    (id: string) => {
      let nowExpanded = false;
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
          nowExpanded = false;
        } else {
          next.add(id);
          nowExpanded = true;
        }
        return next;
      });
      fireToggle(id, nowExpanded);
    },
    [fireToggle],
  );

  useImperativeHandle(ref, () => ({
    focusNode: (id: string) => setFocusedId(id),
    expand: expandNode,
    collapse: collapseNode,
  }));

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (flat.length === 0) return;
      const current = focusedIndex >= 0 ? flat[focusedIndex] : null;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveFocus(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveFocus(-1);
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        setFocusByIndex(0);
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        setFocusByIndex(flat.length - 1);
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        if (!current) return;
        if (current.node.hasChildren) {
          if (!current.expanded) {
            expandNode(current.node.id);
          } else {
            // Move into the first child (which is the next flat row).
            moveFocus(1);
          }
        }
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (!current) return;
        if (current.node.hasChildren && current.expanded) {
          collapseNode(current.node.id);
          return;
        }
        // Walk up to the parent.
        const parentLevel = current.node.level - 1;
        if (parentLevel < 0) return;
        for (let i = focusedIndex - 1; i >= 0; i -= 1) {
          const fn = flat[i];
          if (fn && fn.node.level === parentLevel) {
            setFocusByIndex(i);
            return;
          }
        }
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (!current) return;
        if (canActivate(current.node)) {
          onActivate(current.node);
        } else if (current.node.hasChildren) {
          toggleNode(current.node.id);
        }
        return;
      }

      // Type-ahead: any printable single character.
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const now = Date.now();
        const ch = e.key.toLowerCase();
        if (now - typeAhead.current.lastAt > TYPE_AHEAD_TIMEOUT_MS) {
          typeAhead.current.buffer = "";
        }
        typeAhead.current.buffer += ch;
        typeAhead.current.lastAt = now;
        const buf = typeAhead.current.buffer;

        // Search visible flat list starting from focused+1 (wrap).
        const start = focusedIndex + 1;
        for (let offset = 0; offset < flat.length; offset += 1) {
          const idx = (start + offset) % flat.length;
          const fn = flat[idx];
          if (fn && fn.node.label.toLowerCase().startsWith(buf)) {
            setFocusByIndex(idx);
            e.preventDefault();
            return;
          }
        }
      }
    },
    [
      flat,
      focusedIndex,
      moveFocus,
      setFocusByIndex,
      expandNode,
      collapseNode,
      toggleNode,
      onActivate,
      canActivate,
    ],
  );

  const onCaretClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>, id: string) => {
      e.stopPropagation();
      toggleNode(id);
    },
    [toggleNode],
  );

  const onRowClick = useCallback(
    (flatNode: FlatNode) => {
      setFocusedId(flatNode.node.id);
      if (canActivate(flatNode.node)) {
        onActivate(flatNode.node);
      } else if (flatNode.node.hasChildren) {
        toggleNode(flatNode.node.id);
      }
    },
    [toggleNode, onActivate, canActivate],
  );

  const shouldVirtualize = flat.length > virtualizationThreshold;

  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? flat.length : 0,
    getScrollElement: () => scrollElementRef?.current ?? scrollerRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  // ---------------------------------------------------------------------------
  // DnD sensors — only created when DnD is enabled (avoids hook count issues:
  // useSensor must be called unconditionally, so we always call them but only
  // wire them into DndContext when enableDnd=true).
  // ---------------------------------------------------------------------------
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // ---------------------------------------------------------------------------
  // Standard (non-DnD) row renderer — used when enableDnd=false
  // ---------------------------------------------------------------------------
  const renderRowStandard = useCallback(
    (flatNode: FlatNode, index: number, style?: CSSProperties) => {
      const node = flatNode.node;
      const focused = node.id === focusedId;
      const indent = node.level * 12;
      return (
        <div
          key={node.id}
          role="treeitem"
          aria-level={node.level + 1}
          aria-expanded={node.hasChildren ? flatNode.expanded : undefined}
          aria-selected={focused}
          aria-posinset={index + 1}
          aria-setsize={flat.length}
          data-focused={focused ? "true" : "false"}
          className={styles.row}
          style={{ ...style, paddingInlineStart: 6 + indent }}
          onClick={() => onRowClick(flatNode)}
          title={node.label}
        >
          {node.hasChildren ? (
            <button
              type="button"
              aria-label={flatNode.expanded ? "Collapse" : "Expand"}
              tabIndex={-1}
              className={styles.caret}
              onClick={(e) => onCaretClick(e, node.id)}
              style={{
                transform: flatNode.expanded ? "rotate(90deg)" : "none",
                transition: "transform 100ms",
              }}
            >
              <ChevronRight size={12} />
            </button>
          ) : (
            <span className={styles.caretSpacer} aria-hidden />
          )}
          {renderIcon && <span className={styles.icon}>{renderIcon(node)}</span>}
          <span className={styles.label}>{renderLabel ? renderLabel(node) : node.label}</span>
          {renderBadge && <span className={styles.badge}>{renderBadge(node)}</span>}
        </div>
      );
    },
    [flat.length, focusedId, onRowClick, onCaretClick, renderIcon, renderBadge, renderLabel],
  );

  // ---------------------------------------------------------------------------
  // DnD event handlers
  // ---------------------------------------------------------------------------

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
    setOverId(null);
    setDropPosition(null);
    overIdRef.current = null;
    dropPositionRef.current = null;
  }, []);

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const dragId = String(event.active.id);
      const overNodeId = event.over ? String(event.over.id) : null;

      if (!overNodeId || overNodeId === dragId) {
        setOverId(null);
        setDropPosition(null);
        overIdRef.current = null;
        dropPositionRef.current = null;
        return;
      }

      // Check if allowed
      if (isDndDropAllowed && !isDndDropAllowed(dragId, overNodeId)) {
        setOverId(null);
        setDropPosition(null);
        overIdRef.current = null;
        dropPositionRef.current = null;
        return;
      }

      const overNode = flat.find((f) => f.node.id === overNodeId);
      if (!overNode) {
        setOverId(null);
        setDropPosition(null);
        overIdRef.current = null;
        dropPositionRef.current = null;
        return;
      }

      // Container test: prefer the explicit consumer predicate; fall back to
      // `hasChildren` for back-compat. An EMPTY folder has hasChildren=false
      // but is still a valid drop container — that's why consumers need a way
      // to override this.
      const isContainer = isDropContainer
        ? isDropContainer(overNode.node)
        : overNode.node.hasChildren;

      // Drop-zone heuristic using LIVE pointer Y relative to the over-row rect.
      //
      // For CONTAINERS (folders): default to "into" almost everywhere on the
      // row. Only the top and bottom 2-pixel slivers trigger before/after, to
      // keep reordering possible without making "into" hard to hit.
      // For LEAVES (queries): top half → before, bottom half → after.
      const CONTAINER_EDGE_PX = 2;
      const rect = event.over?.rect;
      const pointerY = pointerYRef.current;

      let position: "before" | "into" | "after";
      if (pointerY !== null && rect && rect.height > 0) {
        const localY = pointerY - rect.top;
        if (isContainer) {
          if (localY < CONTAINER_EDGE_PX) position = "before";
          else if (localY > rect.height - CONTAINER_EDGE_PX) position = "after";
          else position = "into";
        } else {
          position = localY < rect.height / 2 ? "before" : "after";
        }
      } else {
        position = isContainer ? "into" : event.delta.y < 0 ? "before" : "after";
      }

      overIdRef.current = overNodeId;
      dropPositionRef.current = position;
      setOverId(overNodeId);
      setDropPosition(position);
    },
    [flat, isDndDropAllowed, isDropContainer],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const dragId = String(event.active.id);
      // Read from refs — these are written synchronously in handleDragOver,
      // unlike React state which won't have committed yet by the time
      // onDragEnd fires.
      const overNodeId = overIdRef.current ?? (event.over ? String(event.over.id) : null);
      const currentDropPosition = dropPositionRef.current;

      setActiveDragId(null);
      setOverId(null);
      setDropPosition(null);
      overIdRef.current = null;
      dropPositionRef.current = null;

      if (!overNodeId || !currentDropPosition || !onDndDrop) return;
      if (overNodeId === dragId) return;
      if (isDndDropAllowed && !isDndDropAllowed(dragId, overNodeId)) return;

      if (currentDropPosition === "into") {
        onDndDrop(dragId, { type: "into", targetId: overNodeId });
      } else if (currentDropPosition === "before") {
        onDndDrop(dragId, { type: "before", targetId: overNodeId });
      } else {
        onDndDrop(dragId, { type: "after", targetId: overNodeId });
      }
    },
    [onDndDrop, isDndDropAllowed],
  );

  // ---------------------------------------------------------------------------
  // Active drag node (for DragOverlay ghost)
  // ---------------------------------------------------------------------------
  const activeDragNode = useMemo(() => {
    if (!activeDragId) return null;
    return flat.find((f) => f.node.id === activeDragId)?.node ?? null;
  }, [activeDragId, flat]);

  // ---------------------------------------------------------------------------
  // Render DnD row — defers to DraggableRow component
  // ---------------------------------------------------------------------------
  const renderRowDnd = useCallback(
    (flatNode: FlatNode, index: number, style?: CSSProperties) => {
      const node = flatNode.node;
      const isThisDropTarget = node.id === overId;
      return (
        <DraggableRow
          key={node.id}
          flatNode={flatNode}
          index={index}
          total={flat.length}
          focusedId={focusedId}
          isDropTarget={isThisDropTarget}
          dropPosition={isThisDropTarget ? dropPosition : null}
          style={style}
          onRowClick={onRowClick}
          onCaretClick={onCaretClick}
          renderIcon={renderIcon}
          renderBadge={renderBadge}
          renderLabel={renderLabel}
        />
      );
    },
    [
      flat.length,
      focusedId,
      activeDragId,
      overId,
      dropPosition,
      onRowClick,
      onCaretClick,
      renderIcon,
      renderBadge,
      renderLabel,
    ],
  );

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  const renderRow = enableDnd ? renderRowDnd : renderRowStandard;

  if (flat.length === 0) {
    const treeContent = (
      <div className={[styles.tree, className].filter(Boolean).join(" ")} role="tree" aria-label={ariaLabel}>
        <div className={styles.empty}>{empty ?? "Empty"}</div>
      </div>
    );
    if (enableDnd) {
      return (
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          {treeContent}
          <DragOverlay dropAnimation={null}>
            {activeDragNode ? (
              <DragGhost node={activeDragNode} renderIcon={renderIcon} renderLabel={renderLabel} />
            ) : null}
          </DragOverlay>
        </DndContext>
      );
    }
    return treeContent;
  }

  const treeContent = (
    <div
      role="tree"
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={[styles.tree, className].filter(Boolean).join(" ")}
    >
      <div ref={scrollerRef} className={styles.scroller}>
        {shouldVirtualize ? (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              position: "relative",
              width: "100%",
            }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const fn = flat[vi.index];
              if (!fn) return null;
              return renderRow(fn, vi.index, {
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${vi.start}px)`,
                height: rowHeight,
              });
            })}
          </div>
        ) : (
          flat.map((fn, i) => renderRow(fn, i))
        )}
      </div>
    </div>
  );

  if (enableDnd) {
    return (
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        {treeContent}
        <DragOverlay dropAnimation={null}>
          {activeDragNode ? (
            <DragGhost node={activeDragNode} renderIcon={renderIcon} renderLabel={renderLabel} />
          ) : null}
        </DragOverlay>
      </DndContext>
    );
  }

  return treeContent;
});
