import { Plus } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useConnections } from "@/platform/connection-registry/useConnections";
import logoUrl from "@/assets/logo.svg";
import styles from "./Sidebar.module.css";
import dialogStyles from "./Dialog.module.css";

export function Sidebar() {
  return (
    <div className={styles.root}>
      <header className={styles.brand}>
        <img src={logoUrl} alt="" className={styles.brandMark} />
        <span className={styles.brandName}>Argus</span>
      </header>
      <ConnectionsSection />
    </div>
  );
}

function ConnectionsSection() {
  const { items, loading, error } = useConnections();
  const [open, setOpen] = useState(false);

  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <span>Connections</span>
        <button
          aria-label="Add connection"
          title="Add connection (coming soon)"
          onClick={() => setOpen(true)}
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
            <li key={c.id} className={styles.item}>
              <span>{c.name}</span>
              <span className={styles.itemKind}>{c.kind}</span>
            </li>
          ))}
        </ul>
      )}

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className={dialogStyles.overlay} />
          <Dialog.Content className={dialogStyles.content}>
            <Dialog.Title className={dialogStyles.title}>Add connection</Dialog.Title>
            <Dialog.Description className={dialogStyles.description}>
              Connection forms ship in a follow-up change. The shell exposes create/list/delete
              commands today, but the form UI is coming soon.
            </Dialog.Description>
            <div className={dialogStyles.footer}>
              <button className={dialogStyles.primary} onClick={() => setOpen(false)}>
                OK
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
