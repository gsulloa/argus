import { Clock, Loader2, Plus, Power, PowerOff } from "lucide-react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { useMemo, useRef, useState } from "react";
import { useConnections } from "@/platform/connection-registry/useConnections";
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
import { openHistoryTab } from "@/modules/query-history";
import { useTabs } from "@/platform/shell/tabs";
import { listConnectionTabs } from "@/platform/shell/tabs/connectionTabs";
import { listDirtySummaries, listAllDirtySummaries } from "@/platform/shell/tabs/useDirtySummary";
import logoUrl from "@/assets/logo.svg";
import styles from "./Sidebar.module.css";
import dialogStyles from "./Dialog.module.css";
import { SidebarScrollContext } from "./sidebarScroll";
import { DisconnectConfirmDialog } from "./DisconnectConfirmDialog";

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
          <PlatformSection />
        </div>
      </div>
    </SidebarScrollContext.Provider>
  );
}

function ConnectionsSection() {
  const { items, loading, error } = useConnections();
  const { items: activeItems } = useActiveConnections();
  const tabs = useTabs();
  const form = usePostgresForm();
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
    const byId = new Map(items.map((c) => [c.id, c.name] as const));
    return listAllDirtySummaries()
      .filter((s) => activeItems.some((a) => a.id === s.connectionId))
      .map((s) => `${byId.get(s.connectionId) ?? s.connectionId} – ${s.label}`);
  }, [confirmAll, items, activeItems]);

  async function handleDisconnectAll() {
    try {
      await postgresApi.disconnectAll();
    } catch (e) {
      console.error("[argus] disconnect all:", e);
    }
  }

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
          <button
            aria-label="Add connection"
            title="Add Postgres connection"
            onClick={() => form.openCreate()}
          >
            <Plus size={14} strokeWidth={2.5} />
          </button>
        </span>
      </header>

      {loading && <div className={styles.empty}>Loading…</div>}
      {error && <div className={styles.empty}>{error}</div>}

      {!loading && !error && items.length === 0 && (
        <div className={styles.empty}>
          No connections yet. Click <strong>+</strong> to add one.
        </div>
      )}

      {items.length > 0 && (
        <ul className={styles.list}>
          {items.map((c) => (
            <li key={c.id}>
              <ConnectionRow connection={c} />
            </li>
          ))}
        </ul>
      )}

      <DisconnectConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        subject={`all ${activeItems.length} connection${activeItems.length === 1 ? "" : "s"}`}
        tabCount={allTabCount}
        dirtyLabels={allDirtyLabels}
        onConfirm={handleDisconnectAll}
      />
    </section>
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

function ConnectionRow({ connection }: { connection: Connection }) {
  const { isActive } = useActiveConnections();
  const { remove } = useConnections();
  const form = usePostgresForm();
  const tabs = useTabs();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const isPostgres = connection.kind === POSTGRES_KIND;
  const active = isActive(connection.id);
  const readOnly = Boolean(
    (connection.params as Record<string, unknown>).read_only,
  );

  const tabCount = useMemo(
    () => (active ? listConnectionTabs(tabs.tabs, connection.id).length : 0),
    [active, tabs.tabs, connection.id],
  );

  const dirtyLabels = useMemo(
    () => (confirmDisconnect ? listDirtySummaries(connection.id).map((s) => s.label) : []),
    [confirmDisconnect, connection.id],
  );

  async function handleRowClick() {
    if (!isPostgres) return;
    if (active || isConnecting) return;
    setIsConnecting(true);
    try {
      await postgresApi.connect(connection.id);
    } catch (e) {
      console.error("[argus] connect:", e);
    } finally {
      setIsConnecting(false);
    }
  }

  async function handleDisconnect() {
    try {
      await postgresApi.disconnect(connection.id);
    } catch (e) {
      console.error("[argus] disconnect:", e);
    }
  }

  async function handleDelete() {
    try {
      if (active) {
        await postgresApi.disconnect(connection.id);
      }
      await remove(connection.id);
    } catch (e) {
      console.error("[argus] delete connection:", e);
    } finally {
      setConfirmDelete(false);
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

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div className={styles.row}>
            <button
              type="button"
              className={styles.item}
              onClick={handleRowClick}
              title={rowTitle}
              aria-busy={isConnecting || undefined}
            >
              <span className={styles.icon}>
                {isPostgres ? (
                  <PostgresIcon size={14} />
                ) : (
                  <span className={styles.itemKind}>{connection.kind}</span>
                )}
              </span>
              <span className={styles.itemName}>{connection.name}</span>
              {readOnly && <span className={styles.roBadge}>RO</span>}
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
                      connectionId: connection.id,
                      connectionName: connection.name,
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
            <ContextMenu.Item
              className={styles.contextItem}
              onSelect={() => form.openEdit(connection)}
            >
              Edit
            </ContextMenu.Item>
            <ContextMenu.Item
              className={styles.contextItem}
              onSelect={() => form.openDuplicate(connection)}
            >
              Duplicate
            </ContextMenu.Item>
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
        onConfirm={handleDisconnect}
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
