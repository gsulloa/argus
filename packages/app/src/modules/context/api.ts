import { invoke } from "@tauri-apps/api/core";
import { toAppError } from "@/platform/errors/AppError";
import type {
  AiPayload,
  ContextManifest,
  KnownFolder,
  ObjectDoc,
  ObjectListItem,
  QueryDoc,
  QueryListItem,
  SyncReport,
} from "./types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

export const contextApi = {
  createFolder: (path: string, name: string) =>
    call<string>("context_create_folder", { path, name }),

  linkFolder: (connectionId: string, path: string) =>
    call<ContextManifest>("context_link_folder", { connectionId, path }),

  listKnownFolders: () =>
    call<KnownFolder[]>("context_list_known_folders"),

  unlink: (connectionId: string) =>
    call<void>("context_unlink", { connectionId }),

  listObjects: (connectionId: string) =>
    call<ObjectListItem[]>("context_list_objects", { connectionId }),

  getObject: (connectionId: string, identity: string) =>
    call<ObjectDoc | null>("context_get_object", { connectionId, identityStr: identity }),

  listQueries: (connectionId: string) =>
    call<QueryListItem[]>("context_list_queries", { connectionId }),

  getQuery: (connectionId: string, name: string) =>
    call<QueryDoc | null>("context_get_query", { connectionId, name }),

  syncSchema: (connectionId: string) =>
    call<SyncReport>("context_sync_schema", { connectionId }),

  aiPayload: (connectionId: string, includeFullBodies: boolean) =>
    call<AiPayload>("context_ai_payload", { connectionId, includeFullBodies }),

  revealPath: (path: string) =>
    call<void>("context_reveal_path", { path }),
};
