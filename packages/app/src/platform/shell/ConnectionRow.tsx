import { AlertTriangle, GripVertical, Loader2, Power } from "lucide-react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { useMemo, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { invoke } from "@tauri-apps/api/core";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { useConnectionGroups } from "@/platform/connection-registry/useConnectionGroups";
import { computeMidpointSortOrder } from "@/platform/connection-registry/sortOrder";
import { useOpenConnections } from "@/platform/connection-registry/useOpenConnections";
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
import { openDynamoPartiQLTab } from "@/modules/dynamo/sql";
import { DynamoConnectionSubtree, DynamoRefreshButton } from "@/modules/dynamo/tables";
import {
  MYSQL_KIND,
  MysqlIcon,
  MysqlSchemaTree,
  mysqlApi,
  useActiveMysqlConnections,
  useMysqlForm,
} from "@/modules/mysql";
import { openMysqlQueryTab } from "@/modules/mysql/openMysqlQueryTab";
import {
  MSSQL_KIND,
  MssqlIcon,
  mssqlApi,
  useActiveMssqlConnections,
  useMssqlForm,
  MssqlSchemaTree,
  MssqlSchemaPrimaryActions,
  MssqlSchemaToolbar,
} from "@/modules/mssql";
import { openMssqlQueryTab } from "@/modules/mssql/openMssqlQueryTab";
import {
  ATHENA_KIND,
  AthenaIcon,
  athenaApi,
  useActiveAthenaConnections,
  useAthenaForm,
  AthenaSchemaTree,
  AthenaSchemaPrimaryActions,
  AthenaSchemaToolbar,
} from "@/modules/athena";
import { openAthenaQueryTab } from "@/modules/athena/openAthenaQueryTab";
import { ContextQueriesBranch } from "@/modules/context/components/ContextQueriesBranch";
import { openContextQuery } from "@/modules/context/openContextQuery";
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
  mode = "workspace",
}: {
  connection: Connection;
  draggable?: boolean;
  /**
   * "workspace" (default) — full row with active-gated toolbar and inline
   *   subtree. Existing behavior unchanged.
   * "manager" — header-only row (kind icon, name, badges, open/closed dot
   *   driven by the cross-engine open registry). Primary action = open in
   *   Workspace. No subtree. Context menu gains "Close connection".
   */
  mode?: "manager" | "workspace";
}) {
  const pgActive = useActiveConnections();
  const dyActive = useActiveDynamoConnections();
  const myActive = useActiveMysqlConnections();
  const msActive = useActiveMssqlConnections();
  const athenaActive = useActiveAthenaConnections();
  // Cross-engine open registry — used in manager mode for the open/closed dot.
  const openRegistry = useOpenConnections();
  const { items: allConnections, remove, move } = useConnections();
  const { items: groups } = useConnectionGroups();
  const pgForm = usePostgresForm();
  const dyForm = useDynamoForm();
  const myForm = useMysqlForm();
  const msForm = useMssqlForm();
  const athenaForm = useAthenaForm();
  const handleDynamoError = useDynamoErrorHandler();
  const tabs = useTabs();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);

  const isPostgres = connection.kind === POSTGRES_KIND;
  const isDynamo = connection.kind === DYNAMO_KIND;
  const isMySQL = connection.kind === MYSQL_KIND;
  const isMssql = connection.kind === MSSQL_KIND;
  const isAthena = connection.kind === ATHENA_KIND;

  const active = isPostgres
    ? pgActive.isActive(connection.id)
    : isDynamo
      ? dyActive.isActive(connection.id)
      : isMySQL
        ? myActive.isActive(connection.id)
        : isMssql
          ? msActive.isActive(connection.id)
          : isAthena
            ? athenaActive.isActive(connection.id)
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
      confirmDisconnect && (isPostgres || isMySQL || isMssql)
        ? listDirtySummaries(connection.id).map((s) => s.label)
        : [],
    [confirmDisconnect, isPostgres, isMySQL, isMssql, connection.id],
  );

  /**
   * Manager-mode primary click: connect if not already open, then open in the
   * Workspace via workspace_open_connection (Phase 6 coordination).
   *
   * The per-engine connect must happen here in the Manager because connection
   * params and secrets live in the Manager's context.  workspace_open_connection
   * is intentionally engine-agnostic — it only ensures the Workspace window
   * exists, focuses it, and emits workspace:focus-connection so the rail
   * selects the right item.  For an already-open connection the connect step
   * is skipped and workspace_open_connection is called directly (idempotent
   * focus).
   */
  async function handleManagerRowClick() {
    if (isConnecting) return;
    setIsConnecting(true);
    try {
      // Connect only if not already open.
      if (!openRegistry.isOpen(connection.id)) {
        if (isPostgres) {
          await postgresApi.connect(connection.id);
        } else if (isDynamo) {
          try {
            await dynamoApi.connect(connection.id);
          } catch (e) {
            const err = e as Parameters<typeof handleDynamoError>[1];
            await handleDynamoError(connection.id, err);
            return;
          }
        } else if (isMySQL) {
          await mysqlApi.connect(connection.id);
        } else if (isMssql) {
          await mssqlApi.connect(connection.id);
        } else if (isAthena) {
          await athenaApi.connect(connection.id);
        }
      }
      // Open and focus in the Workspace (idempotent for already-open connections).
      await invoke("workspace_open_connection", { id: connection.id });
    } catch (e) {
      console.error("[argus] manager open in workspace:", e);
    } finally {
      setIsConnecting(false);
    }
  }

  /**
   * Manager-mode "Close connection" context menu action.
   * Disconnects via the per-engine disconnect path.
   */
  async function handleManagerCloseConnection() {
    try {
      if (isPostgres) {
        await postgresApi.disconnect(connection.id);
      } else if (isDynamo) {
        await dynamoApi.disconnect(connection.id);
      } else if (isMySQL) {
        await mysqlApi.disconnect(connection.id);
      } else if (isMssql) {
        await mssqlApi.disconnect(connection.id);
      } else if (isAthena) {
        await athenaApi.disconnect(connection.id);
      }
    } catch (e) {
      console.error("[argus] manager close connection:", e);
    }
  }

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
    } else if (isMySQL) {
      setIsConnecting(true);
      try {
        await mysqlApi.connect(connection.id);
      } catch (e) {
        console.error("[argus] mysql connect:", e);
      } finally {
        setIsConnecting(false);
      }
    } else if (isMssql) {
      setIsConnecting(true);
      try {
        await mssqlApi.connect(connection.id);
      } catch (e) {
        console.error("[argus] mssql connect:", e);
      } finally {
        setIsConnecting(false);
      }
    } else if (isAthena) {
      setIsConnecting(true);
      try {
        await athenaApi.connect(connection.id);
      } catch (e) {
        console.error("[argus] athena connect:", e);
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

  async function handleMysqlDisconnect() {
    try {
      await mysqlApi.disconnect(connection.id);
    } catch (e) {
      console.error("[argus] mysql disconnect:", e);
    }
  }

  async function handleMssqlDisconnect() {
    try {
      await mssqlApi.disconnect(connection.id);
    } catch (e) {
      console.error("[argus] mssql disconnect:", e);
    }
  }

  async function handleAthenaDisconnect() {
    try {
      await athenaApi.disconnect(connection.id);
    } catch (e) {
      console.error("[argus] athena disconnect:", e);
    }
  }

  async function handleDelete() {
    try {
      if (active) {
        if (isPostgres) {
          await postgresApi.disconnect(connection.id);
        } else if (isDynamo) {
          await dynamoApi.disconnect(connection.id);
        } else if (isMySQL) {
          await mysqlApi.disconnect(connection.id);
        } else if (isMssql) {
          await mssqlApi.disconnect(connection.id);
        } else if (isAthena) {
          await athenaApi.disconnect(connection.id);
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

  // In manager mode, "active/open" is sourced from the cross-engine open registry.
  // In workspace mode, it uses the per-engine active hooks (existing behavior).
  const isOpenInRegistry = openRegistry.isOpen(connection.id);

  const dotState: "active" | "inactive" | "connecting" = isConnecting
    ? "connecting"
    : mode === "manager"
      ? isOpenInRegistry
        ? "active"
        : "inactive"
      : active
        ? "active"
        : "inactive";

  const rowTitle =
    mode === "manager"
      ? isOpenInRegistry
        ? `Open in Workspace (connected)`
        : isConnecting
          ? "Connecting…"
          : "Open in Workspace"
      : active
        ? connection.name
        : isConnecting
          ? "Connecting…"
          : "Connect";

  // Determine whether the row has any clickable primary action
  const isClickable = isPostgres || isDynamo || isMySQL || isMssql || isAthena;

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            ref={draggable ? sortable.setNodeRef : undefined}
            style={style}
            className={styles.row}
            data-mode={mode}
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
              data-mode={mode}
              onClick={
                isClickable
                  ? mode === "manager"
                    ? handleManagerRowClick
                    : handleRowClick
                  : undefined
              }
              title={isClickable ? rowTitle : connection.name}
              aria-busy={isConnecting || undefined}
            >
              <span className={styles.icon}>
                {isPostgres ? (
                  <PostgresIcon size={mode === "manager" ? 16 : 14} />
                ) : isDynamo ? (
                  <DynamoIcon size={mode === "manager" ? 16 : 14} />
                ) : isMySQL ? (
                  <MysqlIcon size={mode === "manager" ? 16 : 14} />
                ) : isMssql ? (
                  <MssqlIcon size={mode === "manager" ? 16 : 14} />
                ) : isAthena ? (
                  <AthenaIcon size={mode === "manager" ? 16 : 14} />
                ) : (
                  <span className={styles.itemKind}>{connection.kind}</span>
                )}
              </span>
              {/* Manager mode: two-line layout (name + host subtitle) */}
              {mode === "manager" ? (
                <span className={styles.managerItemBody}>
                  <span className={styles.itemName}>{connection.name}</span>
                  <span className={styles.managerHostLine}>
                    {(connection.params as Record<string, unknown>).host as string
                      || (connection.params as Record<string, unknown>).region as string
                      || connection.kind}
                  </span>
                </span>
              ) : (
                <>
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
                </>
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
            {/* Active-gated toolbar — workspace mode only. Not rendered in manager. */}
            {mode === "workspace" && isPostgres && active && (
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
            {mode === "workspace" && isDynamo && active && (
              <>
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
                  <DynamoRefreshButton connectionId={connection.id} />
                </span>
              </>
            )}
            {mode === "workspace" && isMySQL && active && (
              <>
                <span className={styles.rowPrimary}>
                  <button
                    type="button"
                    className={styles.toolbarBtn}
                    title="New SQL query · ⌘↩ runs"
                    aria-label="New SQL query"
                    onClick={(e) => {
                      e.stopPropagation();
                      openMysqlQueryTab(tabs, {
                        connectionId: connection.id,
                        connectionName: connection.name,
                        sql: "",
                      });
                    }}
                  >
                    + Query
                  </button>
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
              </>
            )}
            {mode === "workspace" && isMssql && active && (
              <>
                <span className={styles.rowPrimary}>
                  <MssqlSchemaPrimaryActions connectionId={connection.id} />
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
                  <MssqlSchemaToolbar connectionId={connection.id} />
                </span>
              </>
            )}
            {mode === "workspace" && isAthena && active && (
              <>
                <span className={styles.rowPrimary}>
                  <AthenaSchemaPrimaryActions connectionId={connection.id} />
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
                  <AthenaSchemaToolbar connectionId={connection.id} />
                </span>
              </>
            )}
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={styles.contextMenu}>
            {/* Manager mode: "Close connection" when the connection is open. */}
            {mode === "manager" && isOpenInRegistry && (
              <>
                <ContextMenu.Item
                  className={styles.contextItem}
                  onSelect={() => void handleManagerCloseConnection()}
                >
                  Close connection
                </ContextMenu.Item>
                <ContextMenu.Separator className={styles.contextSeparator} />
              </>
            )}
            {/* Workspace mode: per-engine active-gated "New SQL Query" + "Disconnect". */}
            {mode === "workspace" && isPostgres && active && (
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
            {mode === "workspace" && isDynamo && active && (
              <>
                <ContextMenu.Item
                  className={styles.contextItem}
                  onSelect={() =>
                    openDynamoPartiQLTab(tabs, connection.id, connection.name)
                  }
                >
                  New PartiQL query
                </ContextMenu.Item>
                <ContextMenu.Separator className={styles.contextSeparator} />
                <ContextMenu.Item
                  className={styles.contextItem}
                  onSelect={() => setConfirmDisconnect(true)}
                >
                  Disconnect
                </ContextMenu.Item>
                <ContextMenu.Separator className={styles.contextSeparator} />
              </>
            )}
            {mode === "workspace" && isMySQL && active && (
              <>
                <ContextMenu.Item
                  className={styles.contextItem}
                  onSelect={() =>
                    openMysqlQueryTab(tabs, {
                      connectionId: connection.id,
                      connectionName: connection.name,
                      sql: "",
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
            {mode === "workspace" && isMssql && active && (
              <>
                <ContextMenu.Item
                  className={styles.contextItem}
                  onSelect={() =>
                    openMssqlQueryTab(tabs, {
                      connectionId: connection.id,
                      connectionName: connection.name,
                      sql: "",
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
            {mode === "workspace" && isAthena && active && (
              <>
                <ContextMenu.Item
                  className={styles.contextItem}
                  onSelect={() =>
                    openAthenaQueryTab(tabs, {
                      connectionId: connection.id,
                      connectionName: connection.name,
                      sql: "",
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
            {isMySQL && (
              <>
                <ContextMenu.Item
                  className={styles.contextItem}
                  onSelect={() => myForm.openEdit(connection)}
                >
                  Edit
                </ContextMenu.Item>
                <ContextMenu.Item
                  className={styles.contextItem}
                  onSelect={() => myForm.openDuplicate(connection)}
                >
                  Duplicate
                </ContextMenu.Item>
              </>
            )}
            {isMssql && (
              <>
                <ContextMenu.Item
                  className={styles.contextItem}
                  onSelect={() => msForm.openEdit(connection)}
                >
                  Edit
                </ContextMenu.Item>
                <ContextMenu.Item
                  className={styles.contextItem}
                  onSelect={() => msForm.openDuplicate(connection)}
                >
                  Duplicate
                </ContextMenu.Item>
              </>
            )}
            {isAthena && (
              <>
                <ContextMenu.Item
                  className={styles.contextItem}
                  onSelect={() => athenaForm.openEdit(connection)}
                >
                  Edit
                </ContextMenu.Item>
                <ContextMenu.Item
                  className={styles.contextItem}
                  onSelect={() => athenaForm.openDuplicate(connection)}
                >
                  Duplicate
                </ContextMenu.Item>
              </>
            )}
            {!isPostgres && !isDynamo && !isMySQL && !isMssql && !isAthena && (
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

      {/* Inline subtree — workspace mode only. Not rendered in manager mode. */}
      {mode === "workspace" && isPostgres && active && (
        <div className={styles.subtree}>
          <SchemaTree connectionId={connection.id} />
          <ContextQueriesBranch
            connectionId={connection.id}
            connectionName={connection.name}
            contextPath={connection.context_path}
            engine="postgres"
            onActivate={(q) => {
              void openContextQuery(tabs, connection.id, connection.name, "postgres", q);
            }}
          />
        </div>
      )}
      {mode === "workspace" && isMySQL && active && (
        <div className={styles.subtree}>
          <MysqlSchemaTree connectionId={connection.id} />
          <ContextQueriesBranch
            connectionId={connection.id}
            connectionName={connection.name}
            contextPath={connection.context_path}
            engine="mysql"
            onActivate={(q) => {
              void openContextQuery(tabs, connection.id, connection.name, "mysql", q);
            }}
          />
        </div>
      )}
      {mode === "workspace" && isMssql && active && (
        <div className={styles.subtree}>
          <MssqlSchemaTree connectionId={connection.id} />
          <ContextQueriesBranch
            connectionId={connection.id}
            connectionName={connection.name}
            contextPath={connection.context_path}
            engine="mssql"
            onActivate={(q) => {
              void openContextQuery(tabs, connection.id, connection.name, "mssql", q);
            }}
          />
        </div>
      )}
      {mode === "workspace" && isDynamo && active && (
        <div className={styles.subtree}>
          <DynamoConnectionSubtree connectionId={connection.id} connectionName={connection.name} />
          <ContextQueriesBranch
            connectionId={connection.id}
            connectionName={connection.name}
            contextPath={connection.context_path}
            engine="dynamo"
            onActivate={(q) => {
              void openContextQuery(tabs, connection.id, connection.name, "dynamo", q);
            }}
          />
        </div>
      )}
      {mode === "workspace" && isAthena && active && (
        <div className={styles.subtree}>
          <AthenaSchemaTree connectionId={connection.id} />
        </div>
      )}

      <DisconnectConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        subject={connection.name}
        tabCount={tabCount}
        dirtyLabels={dirtyLabels}
        onConfirm={
          isPostgres
            ? handlePostgresDisconnect
            : isMySQL
              ? handleMysqlDisconnect
              : isMssql
                ? handleMssqlDisconnect
                : isAthena
                  ? handleAthenaDisconnect
                  : handleDynamoDisconnect
        }
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

