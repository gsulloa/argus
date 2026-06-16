import { invoke } from "@tauri-apps/api/core";
import { toAppError } from "@/platform/errors/AppError";
import type {
  FolderDeleteResponse,
  ListResponse,
  SavedQuery,
  SavedQueryFolder,
} from "./types";

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

// ---------------------------------------------------------------------------
// Update query request shape.
//
// Tauri / serde_json serialisation rules for `last_connection_id`:
//   - Field absent from the JS object  → `None` (outer) → backend leaves column untouched.
//   - Field present as `null`           → `Some(None)`   → backend clears the column.
//   - Field present as a UUID string    → `Some(Some(s))`→ backend sets the column.
//
// To guarantee "absent" really means absent (not coerced to JSON `null` by
// accidental undefined serialisation), we build the request object manually
// below using only defined keys. The `UpdateQueryPatch` type therefore marks
// `last_connection_id` as `string | null` (explicit values only); callers
// that do not want to touch the field simply omit the key from the patch.
// ---------------------------------------------------------------------------

export interface UpdateQueryPatch {
  /** Renamed query. If provided, must not be empty after trim. */
  name?: string;
  /** Updated SQL body. */
  sql?: string;
  /**
   * `string`  → set last_connection_id to this UUID.
   * `null`    → clear last_connection_id (set to NULL in DB).
   * omitted   → leave last_connection_id unchanged.
   */
  last_connection_id?: string | null;
}

// ---------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------

export const savedQueriesApi = {
  // -- List ------------------------------------------------------------------

  list(): Promise<ListResponse> {
    return call<ListResponse>("saved_queries_list");
  },

  // -- Folder commands -------------------------------------------------------

  folderCreate(args: { parent_id?: string; name: string }): Promise<SavedQueryFolder> {
    return call<SavedQueryFolder>("saved_queries_folder_create", {
      parentId: args.parent_id ?? null,
      name: args.name,
    });
  },

  folderUpdate(args: { id: string; name: string }): Promise<SavedQueryFolder> {
    return call<SavedQueryFolder>("saved_queries_folder_update", {
      id: args.id,
      name: args.name,
    });
  },

  folderMove(args: {
    id: string;
    target_parent_id: string | null;
    target_sort_order?: number;
  }): Promise<void> {
    return call<void>("saved_queries_folder_move", {
      id: args.id,
      targetParentId: args.target_parent_id,
      targetSortOrder: args.target_sort_order ?? null,
    });
  },

  folderDelete(args: { id: string }): Promise<FolderDeleteResponse> {
    return call<FolderDeleteResponse>("saved_queries_folder_delete", { id: args.id });
  },

  // -- Query commands --------------------------------------------------------

  create(args: {
    folder_id?: string | null;
    name: string;
    sql: string;
    last_connection_id?: string;
  }): Promise<SavedQuery> {
    return call<SavedQuery>("saved_queries_create", {
      folderId: args.folder_id ?? null,
      name: args.name,
      sql: args.sql,
      lastConnectionId: args.last_connection_id ?? null,
    });
  },

  /**
   * Partial update for a saved query.
   *
   * Only fields present on `patch` are sent to the backend. The `request`
   * object is built explicitly so that `undefined` values are never
   * serialised to JSON `null` accidentally.
   */
  update(id: string, patch: UpdateQueryPatch): Promise<SavedQuery> {
    // Build the request manually — only include keys that are defined.
    const request: Record<string, unknown> = { id };
    if (patch.name !== undefined) request["name"] = patch.name;
    if (patch.sql !== undefined) request["sql"] = patch.sql;
    if ("last_connection_id" in patch) {
      // Explicit key present: send it (may be null or a string).
      request["last_connection_id"] = patch.last_connection_id;
    }
    return call<SavedQuery>("saved_queries_update", { request });
  },

  move(args: {
    id: string;
    target_folder_id: string | null;
    target_sort_order?: number;
  }): Promise<void> {
    return call<void>("saved_queries_move", {
      id: args.id,
      targetFolderId: args.target_folder_id,
      targetSortOrder: args.target_sort_order ?? null,
    });
  },

  delete(args: { id: string }): Promise<void> {
    return call<void>("saved_queries_delete", { id: args.id });
  },

  duplicate(args: { id: string }): Promise<SavedQuery> {
    return call<SavedQuery>("saved_queries_duplicate", { id: args.id });
  },
};
