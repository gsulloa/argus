/**
 * useContextFolderLink — shared hook for linking/creating a context folder
 * for a given connection.
 *
 * Extracted from ContextFolderRow so that ContextQueriesBranch's setup CTA
 * can reuse the same logic without duplicating API calls.
 *
 * Exposes:
 *  - `knownFolders`        — list of already-known context folders (null = not yet loaded)
 *  - `knownFoldersLoading` — true while loading known folders
 *  - `busy`                — true during any link/create operation
 *  - `error`               — last error message, or null
 *  - `reuse(path)`         — link the connection to an existing folder at `path`
 *  - `beginCreate()`       — open OS directory picker for new-folder parent, then
 *                            set internal `pendingParentPath`; call `confirmCreate(name)`
 *  - `confirmCreate(name)` — create a subfolder named `name` under the pending parent
 *                            and link it; no-op if `beginCreate()` was not called first
 *  - `chooseExisting()`    — open OS directory picker and link the selected folder
 *
 * All three mutating functions call `onChanged()` on success.
 */
import { useEffect, useState } from "react";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { contextApi } from "@/modules/context/api";
import type { KnownFolder } from "@/modules/context/types";

export interface UseContextFolderLinkResult {
  knownFolders: KnownFolder[] | null;
  knownFoldersLoading: boolean;
  busy: boolean;
  error: string | null;
  reuse: (path: string) => Promise<void>;
  beginCreate: () => Promise<void>;
  confirmCreate: (name: string) => Promise<void>;
  chooseExisting: () => Promise<void>;
}

export function useContextFolderLink(
  connectionId: string,
  onChanged: () => void,
): UseContextFolderLinkResult {
  const [knownFolders, setKnownFolders] = useState<KnownFolder[] | null>(null);
  const [knownFoldersLoading, setKnownFoldersLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingParentPath, setPendingParentPath] = useState<string | null>(null);

  // Load known folders on mount and whenever connectionId changes
  useEffect(() => {
    setKnownFolders(null);
    setKnownFoldersLoading(true);
    contextApi
      .listKnownFolders()
      .then((folders) => {
        setKnownFolders(folders);
      })
      .catch(() => {
        // On error (e.g. command not yet registered in older builds) fall back
        // gracefully to the create/link flow.
        setKnownFolders([]);
      })
      .finally(() => {
        setKnownFoldersLoading(false);
      });
  }, [connectionId]);

  async function reuse(path: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await contextApi.linkFolder(connectionId, path);
      onChanged();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function beginCreate(): Promise<void> {
    const parentPath = await dialogOpen({
      directory: true,
      multiple: false,
      title: "Choose a parent directory for the new context folder",
    });
    if (!parentPath || typeof parentPath !== "string") return;
    setPendingParentPath(parentPath);
  }

  async function confirmCreate(name: string): Promise<void> {
    if (!pendingParentPath) return;
    const fullPath = `${pendingParentPath}/${name}`;
    setBusy(true);
    setError(null);
    try {
      const canonPath = await contextApi.createFolder(fullPath, name);
      await contextApi.linkFolder(connectionId, canonPath);
      setPendingParentPath(null);
      onChanged();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function chooseExisting(): Promise<void> {
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
      onChanged();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return {
    knownFolders,
    knownFoldersLoading,
    busy,
    error,
    reuse,
    beginCreate,
    confirmCreate,
    chooseExisting,
  };
}
