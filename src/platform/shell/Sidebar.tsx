import { Plus } from "lucide-react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useConnections } from "@/platform/connection-registry/useConnections";
import type { Connection } from "@/platform/connection-registry/types";
import {
  POSTGRES_KIND,
  PostgresIcon,
  postgresApi,
  useActiveConnections,
  usePostgresForm,
} from "@/modules/postgres";
import styles from "./Sidebar.module.css";
import dialogStyles from "./Dialog.module.css";

export function Sidebar() {
  return (
    <div className={styles.root}>
      <ConnectionsSection />
    </div>
  );
}

function ConnectionsSection() {
  const { items, loading, error } = useConnections();
  const form = usePostgresForm();

  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <span>Connections</span>
        <button
          aria-label="Add connection"
          title="Add Postgres connection"
          onClick={() => form.openCreate()}
        >
          <Plus size={14} strokeWidth={2.5} />
        </button>
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
    </section>
  );
}

function ConnectionRow({ connection }: { connection: Connection }) {
  const { isActive } = useActiveConnections();
  const { remove } = useConnections();
  const form = usePostgresForm();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isPostgres = connection.kind === POSTGRES_KIND;
  const active = isActive(connection.id);
  const readOnly = Boolean(
    (connection.params as Record<string, unknown>).read_only,
  );

  async function toggleConnect() {
    if (!isPostgres) return;
    try {
      if (active) {
        await postgresApi.disconnect(connection.id);
      } else {
        await postgresApi.connect(connection.id);
      }
    } catch (e) {
      console.error("[argus] toggle connect:", e);
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

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <button
            type="button"
            className={styles.item}
            onClick={toggleConnect}
            title={active ? "Disconnect" : "Connect"}
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
            <span
              className={styles.activeDot}
              data-active={active}
              aria-label={active ? "active" : "inactive"}
            />
          </button>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={styles.contextMenu}>
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
