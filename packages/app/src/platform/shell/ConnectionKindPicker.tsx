import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import dialogStyles from "./Dialog.module.css";
import styles from "./ConnectionKindPicker.module.css";

export interface KindCard {
  kind: string;
  label: string;
  description: string;
  Icon: React.ComponentType<{ size?: number }>;
  onPick: () => void;
}

interface KindPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kinds: KindCard[];
}

export function ConnectionKindPicker({
  open,
  onOpenChange,
  kinds,
}: KindPickerProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.overlay} />
        <Dialog.Content className={dialogStyles.content}>
          <Dialog.Title className={dialogStyles.title}>
            New connection
          </Dialog.Title>
          <Dialog.Description className={dialogStyles.description}>
            Pick a data source.
          </Dialog.Description>
          <div className={styles.grid}>
            {kinds.map((k) => (
              <button
                key={k.kind}
                type="button"
                className={styles.card}
                onClick={() => {
                  onOpenChange(false);
                  k.onPick();
                }}
              >
                <span className={styles.cardIcon}>
                  <k.Icon size={20} />
                </span>
                <span className={styles.cardLabel}>{k.label}</span>
                <span className={styles.cardDesc}>{k.description}</span>
              </button>
            ))}
          </div>
          <div className={dialogStyles.footer}>
            <Dialog.Close asChild>
              <button type="button">Cancel</button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
