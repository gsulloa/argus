import { describe, expect, it, vi } from "vitest";
import { buildTree } from "../types";
import type { SavedQuery, SavedQueryFolder } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _folderId = 0;
let _queryId = 0;

function makeFolder(
  overrides: Partial<SavedQueryFolder> & { id?: string; parent_id?: string | null },
): SavedQueryFolder {
  const id = overrides.id ?? `folder-${++_folderId}`;
  return {
    id,
    parent_id: overrides.parent_id ?? null,
    name: overrides.name ?? `Folder ${id}`,
    sort_order: overrides.sort_order ?? 0,
    created_at: 0,
    updated_at: 0,
  };
}

function makeQuery(
  overrides: Partial<SavedQuery> & { id?: string; folder_id?: string | null },
): SavedQuery {
  const id = overrides.id ?? `query-${++_queryId}`;
  return {
    id,
    folder_id: overrides.folder_id ?? null,
    name: overrides.name ?? `Query ${id}`,
    sql: overrides.sql ?? "SELECT 1",
    sort_order: overrides.sort_order ?? 0,
    last_connection_id: overrides.last_connection_id ?? null,
    created_at: 0,
    updated_at: 0,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildTree", () => {
  it("returns empty array for empty input", () => {
    const tree = buildTree([], []);
    expect(tree).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Root-level queries ordered by sort_order
  // -------------------------------------------------------------------------

  it("returns root queries sorted by sort_order ascending", () => {
    const q1 = makeQuery({ name: "Charlie", sort_order: 2 });
    const q2 = makeQuery({ name: "Alpha", sort_order: 0 });
    const q3 = makeQuery({ name: "Beta", sort_order: 1 });

    const tree = buildTree([], [q1, q2, q3]);

    expect(tree).toHaveLength(3);
    expect(tree[0]?.kind).toBe("query");
    expect(tree[0]?.name).toBe("Alpha");
    expect(tree[1]?.name).toBe("Beta");
    expect(tree[2]?.name).toBe("Charlie");
  });

  it("breaks sort_order ties by name case-insensitive", () => {
    const q1 = makeQuery({ name: "zebra", sort_order: 0 });
    const q2 = makeQuery({ name: "Apple", sort_order: 0 });
    const q3 = makeQuery({ name: "mango", sort_order: 0 });

    const tree = buildTree([], [q1, q2, q3]);

    expect(tree[0]?.name).toBe("Apple");
    expect(tree[1]?.name).toBe("mango");
    expect(tree[2]?.name).toBe("zebra");
  });

  // -------------------------------------------------------------------------
  // Nested folders — 3 levels deep
  // -------------------------------------------------------------------------

  it("assembles nested folders up to 3 levels and preserves order", () => {
    // Level 0 (root)
    const root = makeFolder({ id: "root", name: "root", sort_order: 0 });

    // Level 1 (children of root)
    const l1a = makeFolder({ id: "l1a", parent_id: "root", name: "Alpha", sort_order: 0 });
    const l1b = makeFolder({ id: "l1b", parent_id: "root", name: "Beta", sort_order: 1 });

    // Level 2 (children of l1a)
    const l2a = makeFolder({ id: "l2a", parent_id: "l1a", name: "Deep A", sort_order: 0 });
    const l2b = makeFolder({ id: "l2b", parent_id: "l1a", name: "Deep B", sort_order: 1 });

    // Level 3 (children of l2a)
    const l3 = makeFolder({ id: "l3", parent_id: "l2a", name: "Deepest", sort_order: 0 });

    // Queries at different levels
    const qRoot = makeQuery({ name: "Root Query", folder_id: "root", sort_order: 10 });
    const qL1a = makeQuery({ name: "L1a Query", folder_id: "l1a", sort_order: 5 });
    const qL3 = makeQuery({ name: "L3 Query", folder_id: "l3", sort_order: 0 });

    const tree = buildTree(
      [root, l1a, l1b, l2a, l2b, l3],
      [qRoot, qL1a, qL3],
    );

    // Root level: one root folder
    expect(tree).toHaveLength(1);
    const rootNode = tree[0];
    expect(rootNode?.kind).toBe("folder");
    expect(rootNode?.name).toBe("root");

    if (rootNode?.kind !== "folder") throw new Error("expected folder");

    // Root's children: l1a (sort 0), l1b (sort 1), qRoot (sort 10)
    expect(rootNode.children).toHaveLength(3);
    expect(rootNode.children[0]?.name).toBe("Alpha");
    expect(rootNode.children[1]?.name).toBe("Beta");
    expect(rootNode.children[2]?.name).toBe("Root Query");
    expect(rootNode.children[2]?.kind).toBe("query");

    // l1a's children: l2a (sort 0), l2b (sort 1), qL1a (sort 5)
    const l1aNode = rootNode.children[0];
    if (l1aNode?.kind !== "folder") throw new Error("expected folder");
    expect(l1aNode.children).toHaveLength(3);
    expect(l1aNode.children[0]?.name).toBe("Deep A");
    expect(l1aNode.children[1]?.name).toBe("Deep B");
    expect(l1aNode.children[2]?.name).toBe("L1a Query");

    // l2a's children: l3 (sort 0)
    const l2aNode = l1aNode.children[0];
    if (l2aNode?.kind !== "folder") throw new Error("expected folder");
    expect(l2aNode.children).toHaveLength(1);
    expect(l2aNode.children[0]?.name).toBe("Deepest");

    // Deepest's children: qL3
    const l3Node = l2aNode.children[0];
    if (l3Node?.kind !== "folder") throw new Error("expected folder");
    expect(l3Node.children).toHaveLength(1);
    expect(l3Node.children[0]?.name).toBe("L3 Query");
    expect(l3Node.children[0]?.kind).toBe("query");
  });

  // -------------------------------------------------------------------------
  // Orphan folder
  // -------------------------------------------------------------------------

  it("places orphan folders (unknown parent_id) at root with a console.warn", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const orphan = makeFolder({
      id: "orphan",
      parent_id: "nonexistent-parent",
      name: "Orphan",
      sort_order: 0,
    });

    const tree = buildTree([orphan], []);

    // Orphan should appear at root.
    expect(tree).toHaveLength(1);
    expect(tree[0]?.name).toBe("Orphan");

    // A warning should have been emitted.
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy.mock.calls[0]?.[0]).toMatch(/nonexistent-parent/);

    consoleSpy.mockRestore();
  });

  it("places orphan queries (unknown folder_id) at root with a console.warn", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const orphanQuery = makeQuery({
      id: "orphan-q",
      folder_id: "nonexistent-folder",
      name: "Orphan Query",
    });

    const tree = buildTree([], [orphanQuery]);

    expect(tree).toHaveLength(1);
    expect(tree[0]?.kind).toBe("query");
    expect(tree[0]?.name).toBe("Orphan Query");

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy.mock.calls[0]?.[0]).toMatch(/nonexistent-folder/);

    consoleSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Mixed sort order — folders and queries interleaved by sort_order
  // -------------------------------------------------------------------------

  it("interleaves folders and queries by sort_order (no kind-based separation)", () => {
    const f = makeFolder({ id: "f1", name: "Folder", sort_order: 1 });
    const q1 = makeQuery({ name: "Before Folder", sort_order: 0 });
    const q2 = makeQuery({ name: "After Folder", sort_order: 2 });

    const tree = buildTree([f], [q1, q2]);

    // Sort order: q1(0) < f(1) < q2(2)
    expect(tree).toHaveLength(3);
    expect(tree[0]?.kind).toBe("query");
    expect(tree[0]?.name).toBe("Before Folder");
    expect(tree[1]?.kind).toBe("folder");
    expect(tree[1]?.name).toBe("Folder");
    expect(tree[2]?.kind).toBe("query");
    expect(tree[2]?.name).toBe("After Folder");
  });

  // -------------------------------------------------------------------------
  // raw field is preserved
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Regression: non-empty input must produce a non-empty tree (issue #181)
  // SavedQueriesPanel was not rendered in WorkspaceShell, so the panel never
  // appeared.  This test guards against the store/buildTree side: a non-empty
  // saved_queries_list must yield a non-empty tree so that, once the panel IS
  // mounted, it renders rows rather than the empty-state message.
  // -------------------------------------------------------------------------

  it("produces a non-empty tree for a non-empty folder+query set (regression #181)", () => {
    const folder = makeFolder({ id: "reg-f", name: "My Queries", sort_order: 0 });
    const query = makeQuery({ id: "reg-q", name: "SELECT * FROM users", folder_id: "reg-f" });

    const tree = buildTree([folder], [query]);

    expect(tree.length).toBeGreaterThan(0);
    const folderNode = tree[0];
    expect(folderNode?.kind).toBe("folder");
    if (folderNode?.kind !== "folder") throw new Error("expected folder");
    expect(folderNode.children.length).toBeGreaterThan(0);
    expect(folderNode.children[0]?.kind).toBe("query");
  });

  it("preserves the raw backend record on each node", () => {
    const folder = makeFolder({ id: "f", name: "My Folder" });
    const query = makeQuery({ id: "q", name: "My Query", folder_id: "f" });

    const tree = buildTree([folder], [query]);

    const folderNode = tree[0];
    if (folderNode?.kind !== "folder") throw new Error("expected folder");
    expect(folderNode.raw).toBe(folder);

    const queryNode = folderNode.children[0];
    if (queryNode?.kind !== "query") throw new Error("expected query");
    expect(queryNode.raw).toBe(query);
  });
});
