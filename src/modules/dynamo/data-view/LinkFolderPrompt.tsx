/**
 * LinkFolderPrompt — Task 4.5
 *
 * A lightweight Radix Dialog shown when the user tries to create or edit a
 * model but no context folder is linked. Mirrors the link/create flow from
 * ContextFolderRow (same contextApi + dialog-plugin calls).
 *
 * Props:
 *   open         — controlled visibility
 *   connectionId — the connection to link
 *   onClose()    — called to close without linking
 *   onLinked()   — called on successful link so the caller can refresh and open the editor
 */

import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { Folder } from "lucide-react";
import { contextApi } from "@/modules/context/api";
import type { KnownFolder } from "@/modules/context/types";
import { useConnections } from "@/platform/connection-registry/useConnections";
import { noAutoCorrectProps } from "../../shared/text-input-hygiene";

export interface LinkFolderPromptProps {
  open: boolean;
  connectionId: string;
  onClose(): void;
  onLinked(): void;
}

export function LinkFolderPrompt({
  open,
  connectionId,
  onClose,
  onLinked,
}: LinkFolderPromptProps) {
  const { refresh } = useConnections();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Name prompt state (for "Create folder…" flow)
  const [nameStep, setNameStep] = useState<{ parentPath: string } | null>(null);
  const [folderName, setFolderName] = useState("argus-context");

  // Known-folder discovery
  const [knownFolders, setKnownFolders] = useState<KnownFolder[] | null>(null);
  const [knownFoldersLoading, setKnownFoldersLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKnownFoldersLoading(true);
    contextApi.listKnownFolders().then((folders) => {
      setKnownFolders(folders);
    }).catch(() => {
      setKnownFolders([]);
    }).finally(() => {
      setKnownFoldersLoading(false);
    });
  }, [open]);

  async function handleReuseFolder(path: string) {
    setBusy(true);
    setError(null);
    try {
      await contextApi.linkFolder(connectionId, path);
      await refresh();
      onLinked();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateFolder() {
    const parentPath = await dialogOpen({
      directory: true,
      multiple: false,
      title: "Choose a parent directory for the new context folder",
    });
    if (!parentPath || typeof parentPath !== "string") return;
    setFolderName("argus-context");
    setNameStep({ parentPath });
  }

  async function handleCreateFolderWithName() {
    if (!nameStep || !folderName.trim()) return;
    const fullPath = `${nameStep.parentPath}/${folderName.trim()}`;
    setBusy(true);
    setError(null);
    try {
      const canonPath = await contextApi.createFolder(fullPath, folderName.trim());
      await contextApi.linkFolder(connectionId, canonPath);
      await refresh();
      setNameStep(null);
      onLinked();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleLinkExisting() {
    const picked = await dialogOpen({
      directory: true,
      multiple: false,
      title: "Select context folder",
    });
    if (!picked || typeof picked !== "string") return;
    setBusy(true);
    setError(null);
    try {
      await contextApi.linkFolder(connectionId, picked);
      await refresh();
      onLinked();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function handleClose() {
    setNameStep(null);
    setError(null);
    setKnownFolders(null);
    onClose();
  }

  const dialogStyle: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.55)",
    zIndex: 350,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };

  const contentStyle: React.CSSProperties = {
    width: 400,
    maxWidth: "90vw",
    background: "var(--elevated, #15151b)",
    border: "1px solid var(--border-strong, #2e2f3a)",
    borderRadius: "var(--radius-xl, 12px)",
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
  };

  const titleStyle: React.CSSProperties = {
    fontSize: "14px",
    fontWeight: 600,
    color: "var(--text, #f2f3f7)",
  };

  const hintStyle: React.CSSProperties = {
    fontSize: "12px",
    color: "var(--text-muted, #a0a2ad)",
    lineHeight: 1.5,
  };

  const btnRowStyle: React.CSSProperties = {
    display: "flex",
    gap: "8px",
  };

  const btnBase: React.CSSProperties = {
    flex: 1,
    padding: "6px 12px",
    fontSize: "12px",
    fontFamily: "inherit",
    borderRadius: "var(--radius-md, 5px)",
    cursor: "pointer",
    border: "1px solid var(--border-strong, #2e2f3a)",
    background: "transparent",
    color: "var(--text-muted, #a0a2ad)",
    transition: "background 80ms, color 80ms",
  };

  const btnPrimary: React.CSSProperties = {
    ...btnBase,
    background: "var(--accent, #a855f7)",
    border: "none",
    color: "#fff",
    fontWeight: 500,
  };

  const inputStyle: React.CSSProperties = {
    padding: "6px 10px",
    fontSize: "12px",
    fontFamily: "var(--font-mono, monospace)",
    background: "var(--canvas, #0b0b0f)",
    border: "1px solid var(--border-strong, #2e2f3a)",
    borderRadius: "var(--radius-md, 5px)",
    color: "var(--text, #f2f3f7)",
    outline: "none",
    width: "100%",
    boxSizing: "border-box" as const,
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay style={dialogStyle} />
        <Dialog.Content
          style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 351, pointerEvents: "none" }}
          onInteractOutside={(e) => e.preventDefault()}
          aria-label="Link a context folder"
        >
          <div style={{ ...contentStyle, pointerEvents: "auto" }}>
            <Dialog.Title style={titleStyle}>
              {nameStep ? "New folder name" : "Link a context folder"}
            </Dialog.Title>

            {!nameStep ? (
              <>
                <p style={hintStyle}>
                  Link a context folder to define and save models.
                </p>

                {/* Primary: reuse a known folder */}
                {knownFoldersLoading && (
                  <p style={{ ...hintStyle, fontSize: 11 }}>Loading existing folders…</p>
                )}
                {!knownFoldersLoading && knownFolders != null && knownFolders.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    {knownFolders.map((folder) => (
                      <button
                        key={folder.path}
                        type="button"
                        disabled={busy}
                        onClick={() => void handleReuseFolder(folder.path)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 7,
                          padding: "6px 8px",
                          background: "var(--elevated, #15151b)",
                          border: "1px solid var(--border-strong, #2e2f3a)",
                          borderRadius: "var(--radius-md, 5px)",
                          cursor: "pointer",
                          textAlign: "left",
                          width: "100%",
                          minWidth: 0,
                          transition: "background 80ms ease-out, border-color 80ms ease-out",
                          opacity: busy ? 0.5 : 1,
                        }}
                        onMouseEnter={(e) => {
                          if (!busy) {
                            (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--accent, #a855f7)";
                            (e.currentTarget as HTMLButtonElement).style.background = "var(--surface-2, #23232c)";
                          }
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border-strong, #2e2f3a)";
                          (e.currentTarget as HTMLButtonElement).style.background = "var(--elevated, #15151b)";
                        }}
                      >
                        <Folder size={12} style={{ color: "var(--text-muted, #a0a2ad)", flexShrink: 0 }} />
                        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text, #f2f3f7)", whiteSpace: "nowrap", flexShrink: 0 }}>
                          {folder.name}
                        </span>
                        <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 11, color: "var(--text-subtle, #6b6e7b)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
                          {folder.path}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {error && (
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--danger, #f87171)",
                      background: "rgba(248,113,113,0.07)",
                      border: "1px solid var(--danger, #f87171)",
                      borderRadius: "var(--radius-md, 5px)",
                      padding: "6px 10px",
                    }}
                  >
                    {error}
                  </div>
                )}

                {/* Secondary: create new or choose any path */}
                <div style={btnRowStyle}>
                  <button
                    type="button"
                    style={btnBase}
                    disabled={busy}
                    onClick={() => void handleCreateFolder()}
                  >
                    {(!knownFolders || knownFolders.length === 0) ? "Create folder…" : "New folder…"}
                  </button>
                  <button
                    type="button"
                    style={btnBase}
                    disabled={busy}
                    onClick={() => void handleLinkExisting()}
                  >
                    {(!knownFolders || knownFolders.length === 0) ? "Link existing…" : "Choose other…"}
                  </button>
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    style={{ ...btnBase, flex: "0 0 auto" }}
                    onClick={handleClose}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              /* Name prompt step */
              <>
                <p style={hintStyle}>
                  Choose a name for the new context folder inside<br />
                  <code style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 11 }}>
                    {nameStep.parentPath}
                  </code>
                </p>

                <input
                  type="text"
                  {...noAutoCorrectProps}
                  style={inputStyle}
                  value={folderName}
                  onChange={(e) => setFolderName(e.target.value)}
                  autoFocus
                  placeholder="argus-context"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && folderName.trim()) {
                      void handleCreateFolderWithName();
                    }
                    if (e.key === "Escape") {
                      setNameStep(null);
                    }
                  }}
                />

                {error && (
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--danger, #f87171)",
                      background: "rgba(248,113,113,0.07)",
                      border: "1px solid var(--danger, #f87171)",
                      borderRadius: "var(--radius-md, 5px)",
                      padding: "6px 10px",
                    }}
                  >
                    {error}
                  </div>
                )}

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                  <button
                    type="button"
                    style={{ ...btnBase, flex: "0 0 auto" }}
                    disabled={busy}
                    onClick={() => setNameStep(null)}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    style={{ ...btnPrimary, flex: "0 0 auto" }}
                    disabled={busy || !folderName.trim()}
                    onClick={() => void handleCreateFolderWithName()}
                  >
                    Create
                  </button>
                </div>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
