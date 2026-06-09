import { Clock, Plus, PowerOff } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { useConnectionGroups } from "@/platform/connection-registry/useConnectionGroups";
import { useExpandedGroups } from "@/platform/connection-registry/useExpandedGroups";
import { computeMidpointSortOrder } from "@/platform/connection-registry/sortOrder";
import type { Connection, ConnectionGroup } from "@/platform/connection-registry/types";
import { postgresApi, useActiveConnections } from "@/modules/postgres";
import { mysqlApi, useActiveMysqlConnections } from "@/modules/mysql";
import { mssqlApi, useActiveMssqlConnections } from "@/modules/mssql";
import { useKindPicker } from "./useKindPicker";
import { openHistoryTab } from "@/modules/query-history";
import { useTabs } from "@/platform/shell/tabs";
import { listConnectionTabs } from "@/platform/shell/tabs/connectionTabs";
import { listAllDirtySummaries } from "@/platform/shell/tabs/useDirtySummary";
import logoUrl from "@/assets/logo.svg";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import styles from "./Sidebar.module.css";
import dialogStyles from "./Dialog.module.css";
import { SidebarScrollContext } from "./sidebarScroll";
import { ConnectionRow } from "./ConnectionRow";
import { GroupHeader } from "./GroupHeader";
import {
  UNGROUPED_DROPPABLE_ID,
  resolveConnectionDropTarget,
} from "./dropResolution";
import { DisconnectConfirmDialog } from "./DisconnectConfirmDialog";
import { SavedQueriesPanel } from "@/modules/saved-queries/SavedQueriesPanel";
import { noAutoCorrectProps } from "../../modules/shared/text-input-hygiene";

export { UNGROUPED_DROPPABLE_ID };

export function Sidebar() {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <SidebarScrollContext.Provider value={scrollRef}>
      <div className={styles.root}>
        <header className={styles.brand}>
          <img src={logoUrl} alt="" className={styles.brandMark} />
          <span className={styles.brandName}>Argus</span>
        </header>
        <div ref={scrollRef} className={styles.scroll}>
          <ConnectionsSection />
          <SavedQueriesPanel />
          <PlatformSection />
        </div>
      </div>
    </SidebarScrollContext.Provider>
  );
}

interface RenameDialog {
  groupId: string;
  initialName: string;
}

function ConnectionsSection() {
  const connections = useConnections();
  const groups = useConnectionGroups();
  const picker = useKindPicker();
  const [creatingGroupName, setCreatingGroupName] = useState<string | null>(null);
  const [renameDialog, setRenameDialog] = useState<RenameDialog | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ConnectionGroup | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const grouped = useMemo(() => {
    const byGroup = new Map<string, Connection[]>();
    const ungrouped: Connection[] = [];
    for (const c of connections.items) {
      if (c.group_id) {
        const arr = byGroup.get(c.group_id) ?? [];
        arr.push(c);
        byGroup.set(c.group_id, arr);
      } else {
        ungrouped.push(c);
      }
    }
    return { byGroup, ungrouped };
  }, [connections.items]);

  const groupIds = useMemo(() => groups.items.map((g) => g.id), [groups.items]);
  const { isExpanded, toggle } = useExpandedGroups(groupIds);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function neighborsToSortOrder(targetItems: Connection[], overIndex: number, draggingId: string) {
    const filtered = targetItems.filter((c) => c.id !== draggingId);
    const prev = overIndex > 0 ? filtered[overIndex - 1]?.sort_order : undefined;
    const next = filtered[overIndex]?.sort_order;
    return computeMidpointSortOrder(prev, next);
  }

  async function handleConnectionDragEnd(event: DragEndEvent) {
    if (String(event.active.id).startsWith("group-sortable:")) return;
    const { active, over } = event;
    if (!over) return;
    const draggingId = String(active.id);
    const overId = String(over.id);

    const dragging = connections.items.find((c) => c.id === draggingId);
    if (!dragging) return;

    const result = resolveConnectionDropTarget(
      overId,
      draggingId,
      grouped.byGroup,
      grouped.ungrouped,
    );
    if (!result) return;

    const { groupId: targetGroupId, dropIndex } = result;
    const targetItems =
      targetGroupId === null
        ? grouped.ungrouped
        : grouped.byGroup.get(targetGroupId) ?? [];

    const sortOrder = neighborsToSortOrder(targetItems, dropIndex, draggingId);
    if (
      dragging.group_id === targetGroupId &&
      Math.abs(dragging.sort_order - sortOrder) < 1e-9
    ) {
      return;
    }

    try {
      await connections.move(draggingId, { group_id: targetGroupId, sort_order: sortOrder });
      const groupName = targetGroupId
        ? groups.items.find((g) => g.id === targetGroupId)?.name ?? "group"
        : "Ungrouped";
      setAnnouncement(`Moved ${dragging.name} to ${groupName}, position ${dropIndex + 1}`);
    } catch (e) {
      console.error("[argus] move connection:", e);
    }
  }

  async function handleGroupDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    if (!String(over.id).startsWith("group-sortable:")) return;
    const draggingId = String(active.id).slice("group-sortable:".length);
    const overId = String(over.id).slice("group-sortable:".length);
    const orderedIds = groups.items.map((g) => g.id);
    const draggingIndex = orderedIds.indexOf(draggingId);
    const overIndex = orderedIds.indexOf(overId);
    if (draggingIndex < 0 || overIndex < 0) return;

    const without = groups.items.filter((g) => g.id !== draggingId);
    const insertAt = overIndex > draggingIndex ? overIndex : overIndex;
    const prev = insertAt > 0 ? without[insertAt - 1]?.sort_order : undefined;
    const next = without[insertAt]?.sort_order;
    const sortOrder = computeMidpointSortOrder(prev, next);
    try {
      await groups.update(draggingId, { sort_order: sortOrder });
      const moved = groups.items.find((g) => g.id === draggingId);
      if (moved) setAnnouncement(`Reordered group ${moved.name} to position ${insertAt + 1}`);
    } catch (e) {
      console.error("[argus] reorder group:", e);
    }
  }

  async function createGroup(name: string) {
    if (!name.trim()) return;
    try {
      await groups.create({ name: name.trim() });
    } catch (e) {
      console.error("[argus] create group:", e);
    } finally {
      setCreatingGroupName(null);
    }
  }

  async function renameGroup(id: string, name: string) {
    if (!name.trim()) return;
    try {
      await groups.update(id, { name: name.trim() });
    } catch (e) {
      console.error("[argus] rename group:", e);
    } finally {
      setRenameDialog(null);
    }
  }

  async function sortGroupAlphabetically(group: ConnectionGroup | null) {
    const members =
      group === null ? grouped.ungrouped : grouped.byGroup.get(group.id) ?? [];
    const sorted = [...members].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
    let nextOrder = 1.0;
    try {
      for (const c of sorted) {
        await connections.move(c.id, { group_id: c.group_id, sort_order: nextOrder });
        nextOrder += 1.0;
      }
      setAnnouncement(
        `Sorted ${group === null ? "Ungrouped" : group.name} alphabetically`,
      );
    } catch (e) {
      console.error("[argus] sort alphabetically:", e);
    }
  }

  async function deleteGroup(group: ConnectionGroup) {
    try {
      await groups.remove(group.id);
      await connections.refresh();
    } catch (e) {
      console.error("[argus] delete group:", e);
    } finally {
      setPendingDelete(null);
    }
  }

  const { items: pgActiveItems } = useActiveConnections();
  const { items: myActiveItems } = useActiveMysqlConnections();
  const { items: msActiveItems } = useActiveMssqlConnections();
  const activeItems = [...pgActiveItems, ...myActiveItems, ...msActiveItems];
  const tabs = useTabs();
  const [confirmAll, setConfirmAll] = useState(false);

  const anyActive = activeItems.length > 0;

  const allTabCount = useMemo(() => {
    let count = 0;
    for (const a of activeItems) {
      count += listConnectionTabs(tabs.tabs, a.id).length;
    }
    return count;
  }, [activeItems, tabs.tabs]);

  const allDirtyLabels = useMemo(() => {
    if (!confirmAll) return [];
    const byId = new Map(connections.items.map((c) => [c.id, c.name] as const));
    return listAllDirtySummaries()
      .filter((s) => activeItems.some((a) => a.id === s.connectionId))
      .map((s) => `${byId.get(s.connectionId) ?? s.connectionId} – ${s.label}`);
  }, [confirmAll, connections.items, activeItems]);

  async function handleDisconnectAll() {
    // Fan out to Postgres, MySQL, and MS SQL Server disconnect_all
    const results = await Promise.allSettled([
      postgresApi.disconnectAll(),
      mysqlApi.disconnectAll(),
      mssqlApi.disconnectAll(),
    ]);
    for (const r of results) {
      if (r.status === "rejected") {
        console.error("[argus] disconnect all:", r.reason);
      }
    }
  }

  const loading = connections.loading || groups.loading;
  const error = connections.error ?? groups.error;
  const isEmpty = !loading && !error && connections.items.length === 0 && groups.items.length === 0;

  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <span>Connections</span>
        <span className={styles.sectionActions}>
          {anyActive && (
            <button
              aria-label="Disconnect all"
              title="Disconnect all"
              onClick={() => setConfirmAll(true)}
            >
              <PowerOff size={13} strokeWidth={2.5} />
            </button>
          )}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button aria-label="Add" title="New connection or group">
                <Plus size={14} strokeWidth={2.5} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className={styles.contextMenu} align="end">
                <DropdownMenu.Item
                  className={styles.contextItem}
                  onSelect={() => picker.open()}
                >
                  New connection
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={styles.contextItem}
                  onSelect={() => setCreatingGroupName("")}
                >
                  New group
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </span>
      </header>

      {loading && <div className={styles.empty}>Loading…</div>}
      {error && <div className={styles.empty}>{error}</div>}
      {isEmpty && (
        <div className={styles.empty}>
          No connections yet. Click <strong>+</strong> to add one.
        </div>
      )}

      {!loading && !error && (connections.items.length > 0 || groups.items.length > 0) && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={(event) => {
            if (String(event.active.id).startsWith("group-sortable:")) {
              void handleGroupDragEnd(event);
            } else {
              void handleConnectionDragEnd(event);
            }
          }}
        >
          <SortableContext
            items={groups.items.map((g) => `group-sortable:${g.id}`)}
            strategy={verticalListSortingStrategy}
          >
            <div>
              {groups.items.map((g) => {
                const members = grouped.byGroup.get(g.id) ?? [];
                const expanded = isExpanded(g.id);
                return (
                  <SortableContext
                    key={g.id}
                    items={expanded ? members.map((c) => c.id) : []}
                    strategy={verticalListSortingStrategy}
                  >
                    <GroupHeader
                      group={g}
                      memberCount={members.length}
                      expanded={expanded}
                      onToggle={() => toggle(g.id)}
                      onRename={() =>
                        setRenameDialog({ groupId: g.id, initialName: g.name })
                      }
                      onSortAlphabetically={() => sortGroupAlphabetically(g)}
                      onDelete={() => {
                        if (members.length === 0) {
                          void groups.remove(g.id);
                        } else {
                          setPendingDelete(g);
                        }
                      }}
                    />
                    {expanded && (
                      <div className={styles.groupBody}>
                        {members.map((c) => (
                          <ConnectionRow key={c.id} connection={c} draggable />
                        ))}
                      </div>
                    )}
                  </SortableContext>
                );
              })}
            </div>
          </SortableContext>

          {grouped.ungrouped.length > 0 && (
            <SortableContext
              items={grouped.ungrouped.map((c) => c.id)}
              strategy={verticalListSortingStrategy}
            >
              <UngroupedHeader
                count={grouped.ungrouped.length}
                onSortAlphabetically={() => sortGroupAlphabetically(null)}
              />
              <div className={styles.groupBody}>
                {grouped.ungrouped.map((c) => (
                  <ConnectionRow key={c.id} connection={c} draggable />
                ))}
              </div>
            </SortableContext>
          )}
        </DndContext>
      )}

      <CreateGroupDialog
        open={creatingGroupName !== null}
        initialName={creatingGroupName ?? ""}
        onCancel={() => setCreatingGroupName(null)}
        onConfirm={createGroup}
      />

      <RenameGroupDialog
        dialog={renameDialog}
        onCancel={() => setRenameDialog(null)}
        onConfirm={(name) => {
          if (renameDialog) void renameGroup(renameDialog.groupId, name);
        }}
      />

      <Dialog.Root
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={dialogStyles.overlay} />
          <Dialog.Content className={dialogStyles.content}>
            <Dialog.Title className={dialogStyles.title}>Delete group</Dialog.Title>
            <Dialog.Description className={dialogStyles.description}>
              Delete <strong>{pendingDelete?.name}</strong>? Its connections will move
              to <em>Ungrouped</em>. This cannot be undone.
            </Dialog.Description>
            <div className={dialogStyles.footer}>
              <button onClick={() => setPendingDelete(null)}>Cancel</button>
              <button
                className={dialogStyles.primary}
                onClick={() => pendingDelete && void deleteGroup(pendingDelete)}
              >
                Delete
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <DisconnectConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        subject={`all ${activeItems.length} connection${activeItems.length === 1 ? "" : "s"}`}
        tabCount={allTabCount}
        dirtyLabels={allDirtyLabels}
        onConfirm={handleDisconnectAll}
      />

      <div className={styles.srOnly} role="status" aria-live="polite">
        {announcement}
      </div>
    </section>
  );
}

function UngroupedHeader({
  count,
  onSortAlphabetically,
}: {
  count: number;
  onSortAlphabetically: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: UNGROUPED_DROPPABLE_ID });
  return (
    <div
      ref={setNodeRef}
      className={styles.groupHeader}
      aria-label="Ungrouped section"
      data-over={isOver || undefined}
    >
      <span className={styles.groupChevron} aria-hidden="true" />
      <span className={styles.groupName}>Ungrouped</span>
      <span className={styles.groupCount}>{count}</span>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            className={styles.groupMenuButton}
            aria-label="Ungrouped menu"
            title="Section actions"
          >
            …
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className={styles.contextMenu} align="end">
            <DropdownMenu.Item
              className={styles.contextItem}
              onSelect={onSortAlphabetically}
            >
              Sort alphabetically
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

function CreateGroupDialog({
  open,
  initialName,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  initialName: string;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
        else setName(initialName);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.overlay} />
        <Dialog.Content className={dialogStyles.content}>
          <Dialog.Title className={dialogStyles.title}>New group</Dialog.Title>
          <Dialog.Description className={dialogStyles.description}>
            Pick a name. You can rename it later.
          </Dialog.Description>
          <input
            type="text"
            {...noAutoCorrectProps}
            placeholder="Group name"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onConfirm(name);
              if (e.key === "Escape") onCancel();
            }}
            style={{
              width: "100%",
              padding: "6px 10px",
              borderRadius: 4,
              border: "1px solid var(--border-strong)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 13,
              marginBottom: 16,
            }}
          />
          <div className={dialogStyles.footer}>
            <button onClick={onCancel}>Cancel</button>
            <button className={dialogStyles.primary} onClick={() => onConfirm(name)}>
              Create
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RenameGroupDialog({
  dialog,
  onCancel,
  onConfirm,
}: {
  dialog: RenameDialog | null;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState(dialog?.initialName ?? "");
  return (
    <Dialog.Root
      open={dialog !== null}
      onOpenChange={(o) => {
        if (!o) onCancel();
        else if (dialog) setName(dialog.initialName);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.overlay} />
        <Dialog.Content className={dialogStyles.content}>
          <Dialog.Title className={dialogStyles.title}>Rename group</Dialog.Title>
          <input
            type="text"
            {...noAutoCorrectProps}
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onConfirm(name);
              if (e.key === "Escape") onCancel();
            }}
            style={{
              width: "100%",
              padding: "6px 10px",
              borderRadius: 4,
              border: "1px solid var(--border-strong)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 13,
              marginBottom: 16,
            }}
          />
          <div className={dialogStyles.footer}>
            <button onClick={onCancel}>Cancel</button>
            <button className={dialogStyles.primary} onClick={() => onConfirm(name)}>
              Save
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PlatformSection() {
  const tabs = useTabs();
  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <span>Plataforma</span>
      </header>
      <ul className={styles.list}>
        <li>
          <div className={styles.row}>
            <button
              type="button"
              className={styles.item}
              onClick={() => openHistoryTab(tabs)}
              title="Open query history"
            >
              <span className={styles.icon}>
                <Clock size={14} />
              </span>
              <span className={styles.itemName}>History</span>
            </button>
          </div>
        </li>
      </ul>
    </section>
  );
}
