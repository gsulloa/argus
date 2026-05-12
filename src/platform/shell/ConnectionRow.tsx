import { AlertTriangle, GripVertical, Loader2, Power } from "lucide-react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { useMemo, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { useConnectionGroups } from "@/platform/connection-registry/useConnectionGroups";
import { computeMidpointSortOrder } from "@/platform/connection-registry/sortOrder";
import type { Connection } from "@/platform/connection-registry/types";
import {
  openQueryTab,
  POSTGRES_KIND,
  PostgresIcon,
  postgresApi,
  SchemaPrimaryActions,
  SchemaToolbar,
  SchemaTree,
  useActiveConnections,
  usePostgresForm,
} from "@/modules/postgres";
import {
  DYNAMO_KIND,
  DynamoIcon,
  dynamoApi,
  useActiveDynamoConnections,
  useDynamoForm,
  useDynamoErrorHandler,
  type DynamoParams,
  type ActiveDynamoConnection,
} from "@/modules/dynamo";
import { useTabs } from "@/platform/shell/tabs";
import { listConnectionTabs } from "@/platform/shell/tabs/connectionTabs";
import { listDirtySummaries } from "@/platform/shell/tabs/useDirtySummary";
import { DisconnectConfirmDialog } from "./DisconnectConfirmDialog";
import styles from "./Sidebar.module.css";
import dialogStyles from "./Dialog.module.css";

function dynamoSubtitle(
  connection: Connection,
  active: ActiveDynamoConnection | undefined,
): string {
  const params = connection.params as unknown as DynamoParams;
  const region = params.region;
  if (active) {
    return `${region} · ${active.account_id}`;
  }
  if (params.auth === "profile" && params.profile) {
    return `${region} · ${params.profile}`;
  }
  return `${region} · access-keys`;
}

export function ConnectionRow({
  connection,
  draggable = false,
}: {
  connection: Connection;
  draggable?: boolean;
}) {
  const pgActive = useActiveConnections();
  const dyActive = useActiveDynamoConnections();
  const { items: allConnections, remove, move } = useConnections();
  const { items: groups } = useConnectionGroups();
  const pgForm = usePostgresForm();
  const dyForm = useDynamoForm();
  const handleDynamoError = useDynamoErrorHandler();
  const tabs = useTabs();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);

  const isPostgres = connection.kind === POSTGRES_KIND;
  const isDynamo = connection.kind === DYNAMO_KIND;

  const active = isPostgres
    ? pgActive.isActive(connection.id)
    : isDynamo
      ? dyActive.isActive(connection.id)
      : false;

  const activeDynamoView = isDynamo ? dyActive.getActive(connection.id) : undefined;

  const readOnly = Boolean(
    (connection.params as Record<string, unknown>).read_only,
  );

  const needsCredentials =
    isDynamo &&
    (connection.params as unknown as DynamoParams).needs_credentials === true;

  const sortable = useSortable({ id: connection.id, disabled: !draggable });
  const style = draggable
    ? {
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
        opacity: sortable.isDragging ? 0.5 : 1,
      }
    : undefined;

  const tabCount = useMemo(
    () => (active ? listConnectionTabs(tabs.tabs, connection.id).length : 0),
    [active, tabs.tabs, connection.id],
  );

  const dirtyLabels = useMemo(
    () =>
      confirmDisconnect && isPostgres
        ? listDirtySummaries(connection.id).map((s) => s.label)
        : [],
    [confirmDisconnect, isPostgres, connection.id],
  );

  async function handleRowClick() {
    if (active || isConnecting) return;
    if (isPostgres) {
      setIsConnecting(true);
      try {
        await postgresApi.connect(connection.id);
      } catch (e) {
        console.error("[argus] connect:", e);
      } finally {
        setIsConnecting(false);
      }
    } else if (isDynamo) {
      setIsConnecting(true);
      try {
        await dynamoApi.connect(connection.id);
      } catch (e) {
        const err = e as Parameters<typeof handleDynamoError>[1];
        await handleDynamoError(connection.id, err);
      } finally {
        setIsConnecting(false);
      }
    }
    // unknown kind: no-op
  }

  async function handlePostgresDisconnect() {
    try {
      await postgresApi.disconnect(connection.id);
    } catch (e) {
      console.error("[argus] disconnect:", e);
    }
  }

  async function handleDynamoDisconnect() {
    try {
      await dynamoApi.disconnect(connection.id);
    } catch (e) {
      console.error("[argus] dynamo disconnect:", e);
    }
  }

  async function handleDelete() {
    try {
      if (active) {
        if (isPostgres) {
          await postgresApi.disconnect(connection.id);
        } else if (isDynamo) {
          await dynamoApi.disconnect(connection.id);
        }
      }
      await remove(connection.id);
    } catch (e) {
      console.error("[argus] delete connection:", e);
    } finally {
      setConfirmDelete(false);
    }
  }

  async function moveToGroup(targetGroupId: string | null) {
    const siblings = allConnections.filter(
      (c) => c.group_id === targetGroupId && c.id !== connection.id,
    );
    const last = siblings[siblings.length - 1]?.sort_order;
    const sortOrder = computeMidpointSortOrder(last, undefined);
    try {
      await move(connection.id, { group_id: targetGroupId, sort_order: sortOrder });
    } catch (e) {
      console.error("[argus] move to group:", e);
    }
  }

  const dotState: "active" | "inactive" | "connecting" = isConnecting
    ? "connecting"
    : active
      ? "active"
      : "inactive";

  const rowTitle = active
    ? connection.name
    : isConnecting
      ? "Connecting…"
      : "Connect";

  // Determine whether the row has any clickable primary action
  const isClickable = isPostgres || isDynamo;

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            ref={draggable ? sortable.setNodeRef : undefined}
            style={style}
            className={styles.row}
          >
            {draggable && (
              <button
                type="button"
                className={styles.dragHandle}
                aria-label={`Drag ${connection.name}`}
                {...sortable.attributes}
                {...sortable.listeners}
              >
                <GripVertical size={12} />
              </button>
            )}
            <button
              type="button"
              className={styles.item}
              onClick={isClickable ? handleRowClick : undefined}
              title={isClickable ? rowTitle : connection.name}
              aria-busy={isConnecting || undefined}
            >
              <span className={styles.icon}>
                {isPostgres ? (
                  <PostgresIcon size={14} />
                ) : isDynamo ? (
                  <DynamoIcon size={14} />
                ) : (
                  <span className={styles.itemKind}>{connection.kind}</span>
                )}
              </span>
              <span className={styles.itemName}>{connection.name}</span>
              {isDynamo && active && activeDynamoView && (
                <span className={styles.itemSubtitle}>
                  {dynamoSubtitle(connection, activeDynamoView)}
                </span>
              )}
              {isDynamo && !active && (
                <span className={styles.itemSubtitle}>
                  {dynamoSubtitle(connection, undefined)}
                </span>
              )}
              {readOnly && <span className={styles.roBadge}>RO</span>}
              {needsCredentials && (
                <span
                  className={styles.warningIndicator}
                  title="Session token expired"
                >
                  <AlertTriangle size={12} />
                </span>
              )}
              {dotState === "connecting" ? (
                <span
                  className={`${styles.activeDot} ${styles.activeDotSpinner}`}
                  aria-label="connecting"
                >
                  <Loader2 size={10} strokeWidth={2.5} />
                </span>
              ) : (
                <span
                  className={styles.activeDot}
                  data-active={dotState === "active"}
                  aria-label={dotState === "active" ? "active" : "inactive"}
                />
              )}
            </button>
            {isPostgres && active && (
              <>
                <span className={styles.rowPrimary}>
                  <SchemaPrimaryActions connectionId={connection.id} />
                </span>
                <button
                  type="button"
                  className={styles.disconnectBtn}
                  aria-label="Disconnect"
                  title="Disconnect"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDisconnect(true);
                  }}
                >
                  <Power size={12} strokeWidth={2.5} />
                </button>
                <span className={styles.rowToolbar}>
                  <SchemaToolbar connectionId={connection.id} />
                </span>
              </>
            )}
            {isDynamo && active && (
              <button
                type="button"
                className={styles.disconnectBtn}
                aria-label="Disconnect"
                title="Disconnect"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmDisconnect(true);
                }}
              >
                <Power size={12} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={styles.contextMenu}>
            {isPostgres && active && (
              <>
                <ContextMenu.Item
                  className={styles.contextItem}
                  onSelect={() =>
                    openQueryTab(tabs, {
                      initialConnectionId: connection.id,
                      initialConnectionName: connection.name,
                      initialSql: "",
                    })
                  }
                >
                  New SQL Query
                </ContextMenu.Item>
                <ContextMenu.Item
                  className={styles.contextItem}
                  onSelect={() => setConfirmDisconnect(true)}
                >
                  Disconnect
                </ContextMenu.Item>
                <ContextMenu.Separator className={styles.contextSeparator} />
              </>
            )}
            {isDynamo && active && (
              <>
                <ContextMenu.Item
                  className={styles.contextItem}
                  onSelect={() => setConfirmDisconnect(true)}
                >
                  Disconnect
                </ContextMenu.Item>
                <ContextMenu.Separator className={styles.contextSeparator} />
              </>
            )}
            {isPostgres && (
              <>
                <ContextMenu.Item
                  className={styles.contextItem}
                  onSelect={() => pgForm.openEdit(connection)}
                >
                  Edit
                </ContextMenu.Item>
                <ContextMenu.Item
                  className={styles.contextItem}
                  onSelect={() => pgForm.openDuplicate(connection)}
                >
                  Duplicate
                </ContextMenu.Item>
              </>
            )}
            {isDynamo && (
              <>
                <ContextMenu.Item
                  className={styles.contextItem}
                  onSelect={() => dyForm.openEdit(connection)}
                >
                  Edit
                </ContextMenu.Item>
                <ContextMenu.Item
                  className={styles.contextItem}
                  onSelect={() => dyForm.openDuplicate(connection)}
                >
                  Duplicate
                </ContextMenu.Item>
              </>
            )}
            {!isPostgres && !isDynamo && (
              <ContextMenu.Item className={styles.contextItem} disabled>
                {connection.kind}
              </ContextMenu.Item>
            )}
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger className={styles.contextItem}>
                Move to group ▸
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent className={styles.contextMenu}>
                  {groups.map((g) => (
                    <ContextMenu.Item
                      key={g.id}
                      className={styles.contextItem}
                      disabled={g.id === connection.group_id}
                      onSelect={() => void moveToGroup(g.id)}
                    >
                      {g.name}
                    </ContextMenu.Item>
                  ))}
                  {groups.length > 0 && (
                    <ContextMenu.Separator className={styles.contextSeparator} />
                  )}
                  <ContextMenu.Item
                    className={styles.contextItem}
                    disabled={connection.group_id === null}
                    onSelect={() => void moveToGroup(null)}
                  >
                    Ungrouped
                  </ContextMenu.Item>
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
            <ContextMenu.Item
              className={`${styles.contextItem} ${styles.contextItemDanger}`}
              onSelect={() => setConfirmDelete(true)}
            >
              Delete
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      {isPostgres && active && (
        <div className={styles.subtree}>
          <SchemaTree connectionId={connection.id} />
        </div>
      )}

      <DisconnectConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        subject={connection.name}
        tabCount={tabCount}
        dirtyLabels={dirtyLabels}
        onConfirm={isPostgres ? handlePostgresDisconnect : handleDynamoDisconnect}
      />

      <Dialog.Root open={confirmDelete} onOpenChange={setConfirmDelete}>
        <Dialog.Portal>
          <Dialog.Overlay className={dialogStyles.overlay} />
          <Dialog.Content className={dialogStyles.content}>
            <Dialog.Title className={dialogStyles.title}>Delete connection</Dialog.Title>
            <Dialog.Description className={dialogStyles.description}>
              Delete <strong>{connection.name}</strong>? Its keychain entry will be removed too.
              This cannot be undone.
            </Dialog.Description>
            <div className={dialogStyles.footer}>
              <button onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button className={dialogStyles.primary} onClick={handleDelete}>
                Delete
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
