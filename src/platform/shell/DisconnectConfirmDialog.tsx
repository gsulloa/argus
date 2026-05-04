import * as Dialog from "@radix-ui/react-dialog";
import dialogStyles from "./Dialog.module.css";
import styles from "./DisconnectConfirmDialog.module.css";

export interface DisconnectConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Heading subject. For per-row disconnect this is the connection name; for
   * Disconnect-all this is something like "all 3 connections".
   */
  subject: string;
  tabCount: number;
  /**
   * Labels of dirty buffers that would be discarded. Per-row uses bare
   * `<schema>.<table>`; Disconnect-all uses `<connection> – <schema>.<table>`.
   */
  dirtyLabels: string[];
  onConfirm: () => void;
}

export function DisconnectConfirmDialog({
  open,
  onOpenChange,
  subject,
  tabCount,
  dirtyLabels,
  onConfirm,
}: DisconnectConfirmDialogProps) {
  const dirtyCount = dirtyLabels.length;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.overlay} />
        <Dialog.Content className={dialogStyles.content}>
          <Dialog.Title className={dialogStyles.title}>
            Disconnect {subject}?
          </Dialog.Title>
          <Dialog.Description asChild>
            <div className={dialogStyles.description}>
              {tabCount > 0 && (
                <div>
                  {tabCount} tab{tabCount === 1 ? "" : "s"} will close.
                </div>
              )}
              {dirtyCount > 0 && (
                <div className={styles.warning}>
                  <span className={styles.warningHeader}>
                    ⚠ {dirtyCount} unsaved edit{dirtyCount === 1 ? "" : "s"} will be discarded:
                  </span>
                  <ul className={styles.warningList}>
                    {dirtyLabels.map((label) => (
                      <li key={label}>{label}</li>
                    ))}
                  </ul>
                </div>
              )}
              {tabCount === 0 && dirtyCount === 0 && (
                <div>This will release the pool and clear cached schema data.</div>
              )}
            </div>
          </Dialog.Description>
          <div className={dialogStyles.footer}>
            <button type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </button>
            <button
              type="button"
              className={`${dialogStyles.primary} ${styles.destructive}`}
              onClick={() => {
                onConfirm();
                onOpenChange(false);
              }}
            >
              Disconnect
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
