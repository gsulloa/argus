/**
 * NamedQueryModal — single modal for Create and Update NamedQuery flows (D3).
 *
 * CREATE mode: collects name, description, database (select), workGroup (select).
 * UPDATE mode: collects name, description only; database + workGroup shown read-only.
 *
 * Props:
 *  - `open`            — controls Radix dialog visibility.
 *  - `mode`            — "create" | "update"
 *  - `connectionId`    — used to fetch listDatabases.
 *  - `defaultDatabase` — pre-fills the database picker in Create mode.
 *  - `defaultWorkGroup`— pre-fills the workgroup picker in Create mode.
 *  - `origin`          — for Update mode: supplies immutable database + workGroup.
 *  - `initialName`     — pre-filled name (Update mode: origin.name).
 *  - `initialDescription` — pre-filled description.
 *  - `onClose`         — called when the user cancels.
 *  - `onConfirm`       — called with form data on save.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { athenaApi } from "../api";
import { noAutoCorrectProps } from "@/modules/shared/text-input-hygiene";
import type { AthenaQueryOrigin } from "./QueryTab";
import dialogStyles from "@/platform/shell/Dialog.module.css";
import styles from "./NamedQueryModal.module.css";

export interface NamedQueryModalCreateResult {
  mode: "create";
  name: string;
  description: string;
  database: string;
  workGroup: string;
}

export interface NamedQueryModalUpdateResult {
  mode: "update";
  name: string;
  description: string;
}

export type NamedQueryModalResult = NamedQueryModalCreateResult | NamedQueryModalUpdateResult;

interface CreateModeProps {
  mode: "create";
  connectionId: string;
  defaultDatabase?: string;
  defaultWorkGroup: string;
}

interface UpdateModeProps {
  mode: "update";
  origin: AthenaQueryOrigin;
}

type ModeProps = CreateModeProps | UpdateModeProps;

type Props = ModeProps & {
  open: boolean;
  initialName?: string;
  initialDescription?: string;
  onClose: () => void;
  onConfirm: (result: NamedQueryModalResult) => void;
};

export function NamedQueryModal(props: Props) {
  const { open, initialName = "", initialDescription = "", onClose, onConfirm } = props;
  const nameRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);

  // Create-mode state
  const [databases, setDatabases] = useState<string[]>([]);
  const [dbsLoading, setDbsLoading] = useState(false);
  const [dbError, setDbError] = useState(false);
  const [selectedDb, setSelectedDb] = useState(
    props.mode === "create" ? (props.defaultDatabase ?? "") : "",
  );
  const [selectedWg, setSelectedWg] = useState(
    props.mode === "create" ? props.defaultWorkGroup : "",
  );

  // Reset state whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setDescription(initialDescription);

    if (props.mode === "create") {
      const defaultDb = props.defaultDatabase ?? "";
      setSelectedDb(defaultDb);
      setSelectedWg(props.defaultWorkGroup);
      // Load databases list
      setDbsLoading(true);
      setDbError(false);
      athenaApi
        .listDatabases(props.connectionId)
        .then((dbs) => {
          const names = dbs.map((d) => d.name);
          setDatabases(names);
          // If defaultDatabase is in the list use it, else pick the first.
          setSelectedDb((prev) => {
            if (prev && names.includes(prev)) return prev;
            return names[0] ?? prev;
          });
        })
        .catch(() => {
          setDbError(true);
        })
        .finally(() => {
          setDbsLoading(false);
        });
    }
    // Focus name input
    setTimeout(() => nameRef.current?.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleSubmit = useCallback(() => {
    const trimmedName = name.trim();
    if (!trimmedName) return;

    if (props.mode === "create") {
      onConfirm({
        mode: "create",
        name: trimmedName,
        description: description.trim(),
        database: selectedDb,
        workGroup: selectedWg,
      });
    } else {
      onConfirm({
        mode: "update",
        name: trimmedName,
        description: description.trim(),
      });
    }
  }, [name, description, selectedDb, selectedWg, props.mode, onConfirm]);

  const title = props.mode === "create" ? "Save as Named Query" : `Update "${props.origin.name}"`;

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.overlay} />
        <Dialog.Content className={dialogStyles.content} style={{ minWidth: 420 }}>
          <Dialog.Title className={dialogStyles.title}>{title}</Dialog.Title>

          {/* Name */}
          <label className={styles.label} htmlFor="nq-modal-name">Name</label>
          <input
            {...noAutoCorrectProps}
            id="nq-modal-name"
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

          {/* Description */}
          <label className={styles.label} htmlFor="nq-modal-description">Description (optional)</label>
          <input
            {...noAutoCorrectProps}
            id="nq-modal-description"
            type="text"
            className={styles.input}
            placeholder="Short description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
              if (e.key === "Escape") onClose();
            }}
          />

          {/* Database — Create mode: editable select; Update mode: read-only */}
          {props.mode === "create" ? (
            <>
              <label className={styles.label} htmlFor="nq-modal-database">Database</label>
              {dbError ? (
                // Fall back to free-text input when listDatabases fails
                <input
                  {...noAutoCorrectProps}
                  id="nq-modal-database"
                  type="text"
                  className={styles.input}
                  placeholder="database name"
                  value={selectedDb}
                  onChange={(e) => setSelectedDb(e.target.value)}
                />
              ) : (
                <select
                  id="nq-modal-database"
                  className={styles.select}
                  value={selectedDb}
                  onChange={(e) => setSelectedDb(e.target.value)}
                  disabled={dbsLoading}
                >
                  {dbsLoading && <option value="">Loading…</option>}
                  {!dbsLoading && databases.length === 0 && (
                    <option value={selectedDb}>{selectedDb || "(no databases)"}</option>
                  )}
                  {databases.map((db) => (
                    <option key={db} value={db}>{db}</option>
                  ))}
                </select>
              )}

              {/* WorkGroup — pre-filled from connection, user may type another */}
              <label className={styles.label} htmlFor="nq-modal-workgroup">WorkGroup</label>
              <input
                {...noAutoCorrectProps}
                id="nq-modal-workgroup"
                type="text"
                className={styles.input}
                placeholder="primary"
                value={selectedWg}
                onChange={(e) => setSelectedWg(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSubmit();
                  if (e.key === "Escape") onClose();
                }}
              />
            </>
          ) : (
            /* Update mode: database + workGroup shown read-only (AWS cannot change them) */
            <>
              <label className={styles.label}>Database</label>
              <div className={styles.readonlyRow}>
                <span className={styles.readonlyValue}>{props.origin.database}</span>
                <span className={styles.readonlyHint}>immutable</span>
              </div>
              <label className={styles.label}>WorkGroup</label>
              <div className={styles.readonlyRow}>
                <span className={styles.readonlyValue}>{props.origin.workGroup}</span>
                <span className={styles.readonlyHint}>immutable</span>
              </div>
            </>
          )}

          <div className={dialogStyles.footer} style={{ marginTop: 16 }}>
            <button type="button" onClick={onClose}>Cancel</button>
            <button
              type="button"
              className={dialogStyles.primary}
              disabled={!name.trim() || (props.mode === "create" && !selectedDb.trim())}
              onClick={handleSubmit}
            >
              {props.mode === "create" ? "Save" : "Update"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
