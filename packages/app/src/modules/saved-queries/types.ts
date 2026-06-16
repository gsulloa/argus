// ---------------------------------------------------------------------------
// Raw types — mirror Rust serde shapes exactly (snake_case)
// ---------------------------------------------------------------------------

export interface SavedQueryFolder {
  id: string;
  parent_id: string | null;
  name: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface SavedQuery {
  id: string;
  folder_id: string | null;
  name: string;
  sql: string;
  sort_order: number;
  /** UUID string or null when no connection has been associated. */
  last_connection_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ListResponse {
  folders: SavedQueryFolder[];
  queries: SavedQuery[];
}

export interface FolderDeleteResponse {
  folders_deleted: number;
  queries_deleted: number;
}

// ---------------------------------------------------------------------------
// Tree types — camelCase, used exclusively in the frontend layer
// ---------------------------------------------------------------------------

export interface FolderNode {
  kind: "folder";
  id: string;
  name: string;
  sortOrder: number;
  parentId: string | null;
  children: TreeNode[];
  raw: SavedQueryFolder;
}

export interface QueryNode {
  kind: "query";
  id: string;
  name: string;
  sortOrder: number;
  folderId: string | null;
  raw: SavedQuery;
}

export type TreeNode = FolderNode | QueryNode;

// ---------------------------------------------------------------------------
// buildTree — assemble flat arrays into a nested tree.
//
// Sort order: within each level, items share a global sort_order key (not
// separated by kind). Primary sort key is sort_order ASC, tie-break is name
// case-insensitive ASC. This mirrors the backend's ORDER BY clause:
//   ORDER BY ... sort_order ASC, name COLLATE NOCASE ASC
//
// Orphan handling: if a folder's parent_id references a folder id that does
// NOT appear in the `folders` array, the orphaned folder is placed at root
// with a console.warn. This prevents silent data loss and makes debugging
// straightforward.
// ---------------------------------------------------------------------------

export function buildTree(
  folders: SavedQueryFolder[],
  queries: SavedQuery[],
): TreeNode[] {
  const folderMap = new Map<string, FolderNode>();

  // First pass: create all FolderNode entries (children populated later).
  for (const f of folders) {
    folderMap.set(f.id, {
      kind: "folder",
      id: f.id,
      name: f.name,
      sortOrder: f.sort_order,
      parentId: f.parent_id,
      children: [],
      raw: f,
    });
  }

  // Comparator: sort_order ASC, then name case-insensitive ASC.
  function cmp(a: TreeNode, b: TreeNode): number {
    const orderDiff = a.sortOrder - b.sortOrder;
    if (orderDiff !== 0) return orderDiff;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  }

  const roots: TreeNode[] = [];

  // Second pass: wire folders into their parent or root.
  for (const [, node] of folderMap) {
    if (node.parentId === null) {
      roots.push(node);
    } else {
      const parent = folderMap.get(node.parentId);
      if (parent) {
        parent.children.push(node);
      } else {
        // Orphan folder: parent_id references a non-existent folder.
        // Place at root and warn so developers can diagnose data integrity
        // issues without silently hiding folders.
        console.warn(
          `[saved-queries] Folder "${node.name}" (${node.id}) references ` +
            `unknown parent_id "${node.parentId}". Placing at root.`,
        );
        roots.push(node);
      }
    }
  }

  // Third pass: add QueryNodes to the correct parent or root.
  for (const q of queries) {
    const qNode: QueryNode = {
      kind: "query",
      id: q.id,
      name: q.name,
      sortOrder: q.sort_order,
      folderId: q.folder_id,
      raw: q,
    };

    if (q.folder_id === null) {
      roots.push(qNode);
    } else {
      const parent = folderMap.get(q.folder_id);
      if (parent) {
        parent.children.push(qNode);
      } else {
        // Orphan query: folder_id references a non-existent folder.
        console.warn(
          `[saved-queries] Query "${q.name}" (${q.id}) references ` +
            `unknown folder_id "${q.folder_id}". Placing at root.`,
        );
        roots.push(qNode);
      }
    }
  }

  // Sort each level recursively.
  function sortLevel(nodes: TreeNode[]): TreeNode[] {
    nodes.sort(cmp);
    for (const node of nodes) {
      if (node.kind === "folder") {
        sortLevel(node.children);
      }
    }
    return nodes;
  }

  return sortLevel(roots);
}
