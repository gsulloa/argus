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
} from "react";
import { ChevronRight } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
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

export interface SidebarTreeProps {
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
  },
  ref,
) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(defaultExpanded ?? []));
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const typeAhead = useRef<{ buffer: string; lastAt: number }>({ buffer: "", lastAt: 0 });

  const isExpanded = useCallback(
    (id: string) => expanded.has(id) || (forceExpanded?.has(id) ?? false),
    [expanded, forceExpanded],
  );

  const flat = useMemo(() => {
    const out: FlatNode[] = [];
    flatten(nodes, isExpanded, out);
    return out;
  }, [nodes, isExpanded]);

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

  const expandNode = useCallback((id: string) => {
    setExpanded((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const collapseNode = useCallback((id: string) => {
    setExpanded((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const toggleNode = useCallback(
    (id: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [],
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
        if (current.node.hasChildren) {
          toggleNode(current.node.id);
        } else {
          onActivate(current.node);
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
      if (flatNode.node.hasChildren) {
        toggleNode(flatNode.node.id);
      } else {
        onActivate(flatNode.node);
      }
    },
    [toggleNode, onActivate],
  );

  const shouldVirtualize = flat.length > virtualizationThreshold;

  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? flat.length : 0,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  const renderRow = useCallback(
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

  if (flat.length === 0) {
    return (
      <div className={[styles.tree, className].filter(Boolean).join(" ")} role="tree" aria-label={ariaLabel}>
        <div className={styles.empty}>{empty ?? "Empty"}</div>
      </div>
    );
  }

  return (
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
});
