/**
 * SaveAsModal — first-save dialog for SQL query tabs.
 *
 * Shows only a Name input. The query is always saved to the connection's
 * linked context folder — no folder picker is presented.
 *
 * Props:
 *  - `defaultName`   — pre-filled value for the Name field.
 *  - `open`          — controls Radix dialog visibility.
 *  - `onClose`       — called when the user cancels.
 *  - `onConfirm`     — called with { name } when the user saves.
 */

import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import dialogStyles from "@/platform/shell/Dialog.module.css";
import styles from "./SaveAsModal.module.css";
import { noAutoCorrectProps } from "../shared/text-input-hygiene";

export interface SaveAsModalProps {
  open: boolean;
  defaultName: string;
  onClose: () => void;
  onConfirm: (result: { name: string }) => void;
}

export function SaveAsModal({
  open,
  defaultName,
  onClose,
  onConfirm,
}: SaveAsModalProps) {
  const [name, setName] = useState(defaultName);
  const nameRef = useRef<HTMLInputElement>(null);

  // Reset fields when opened.
  useEffect(() => {
    if (open) {
      setName(defaultName);
      // Focus name input.
      setTimeout(() => nameRef.current?.focus(), 0);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onConfirm({ name: trimmed });
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.overlay} />
        <Dialog.Content className={dialogStyles.content} style={{ minWidth: 400 }}>
          <Dialog.Title className={dialogStyles.title}>Save Query</Dialog.Title>

          {/* Name field */}
          <label className={styles.label} htmlFor="save-as-name">Name</label>
          <input
            {...noAutoCorrectProps}
            id="save-as-name"
            ref={nameRef}
            type="text"
            className={styles.input}
            placeholder="Query name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
              if (e.key === "Escape") onClose();
            }}
          />

          <div className={dialogStyles.footer} style={{ marginTop: 16 }}>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className={dialogStyles.primary}
              disabled={!name.trim()}
              onClick={handleSubmit}
            >
              Save
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
