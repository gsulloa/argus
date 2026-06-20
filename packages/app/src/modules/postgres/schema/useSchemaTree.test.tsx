/**
 * Integration test for the schema-tree cache across connection focus switches
 * (issue #151). Verifies that switching focus between two connections seeds
 * from the process-wide cache and does NOT re-issue listSchemas / listRelations
 * for an already-loaded connection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const mockListSchemas = vi.fn();
const mockListRelations = vi.fn();
const mockListColumnsBulk = vi.fn();

vi.mock("./api", () => ({
  schemaApi: {
    listSchemas: (id: string) => mockListSchemas(id),
    listRelations: (id: string, schema: string) => mockListRelations(id, schema),
    listColumnsBulk: (id: string, schema: string, mode: string) =>
      mockListColumnsBulk(id, schema, mode),
    listStructure: vi.fn(() => Promise.resolve({ failures: [] })),
    listTableExtras: vi.fn(() => Promise.resolve({ failures: [] })),
  },
}));

Object.defineProperty(window, "__TAURI_INTERNALS__", {
  value: {},
  writable: true,
  configurable: true,
});

import { useSchemaTree } from "./useSchemaTree";
import { globalSchemaCache } from "./globalSchemaCache";

const A = "conn-a";
const B = "conn-b";

const schemasA = [{ name: "public", is_system: false }];
const schemasB = [{ name: "app", is_system: false }];
const relsA = { tables: [{ name: "users" }], views: [], materialized_views: [] };

beforeEach(() => {
  globalSchemaCache.invalidate(A);
  globalSchemaCache.invalidate(B);
  mockListSchemas.mockReset();
  mockListRelations.mockReset();
  mockListColumnsBulk.mockReset();
  mockListSchemas.mockImplementation((id: string) =>
    Promise.resolve(id === A ? schemasA : schemasB),
  );
  mockListRelations.mockImplementation(() => Promise.resolve(relsA));
  mockListColumnsBulk.mockResolvedValue({ columns_by_relation: {} });
});

describe("useSchemaTree — cache across focus switches (#151)", () => {
  it("does not re-fetch listSchemas when returning to an already-loaded connection", async () => {
    const { result, rerender } = renderHook(({ id }) => useSchemaTree(id), {
      initialProps: { id: A },
    });

    await waitFor(() => expect(result.current.schemas.length).toBe(1));
    expect(mockListSchemas).toHaveBeenCalledTimes(1);

    // Switch focus to B → loads B once.
    rerender({ id: B });
    await waitFor(() => expect(result.current.schemas[0]?.name).toBe("app"));
    expect(mockListSchemas).toHaveBeenCalledTimes(2);

    // Switch back to A → should seed from cache, NO new listSchemas.
    rerender({ id: A });
    await waitFor(() => expect(result.current.schemas[0]?.name).toBe("public"));
    expect(mockListSchemas).toHaveBeenCalledTimes(2);
  });

  it("seeds cached relations on return — no listRelations re-fetch", async () => {
    const { result, rerender } = renderHook(({ id }) => useSchemaTree(id), {
      initialProps: { id: A },
    });
    await waitFor(() => expect(result.current.schemas.length).toBe(1));

    // Expand relations for "public" on A.
    act(() => {
      result.current.getRelations("public");
    });
    await waitFor(() =>
      expect(result.current.getRelationsState("public")).toBe("loaded"),
    );
    expect(mockListRelations).toHaveBeenCalledTimes(1);

    // Switch to B and back to A.
    rerender({ id: B });
    await waitFor(() => expect(result.current.schemas[0]?.name).toBe("app"));
    rerender({ id: A });
    await waitFor(() => expect(result.current.schemas[0]?.name).toBe("public"));

    // Relations for A.public must be served from cache (seeded as loaded).
    expect(result.current.getRelationsState("public")).toBe("loaded");
    expect(result.current.getRelations("public")).toEqual(relsA);
    expect(mockListRelations).toHaveBeenCalledTimes(1);
  });

  it("simulates a full unmount/remount (keyed tree) and still serves cache", async () => {
    const first = renderHook(({ id }) => useSchemaTree(id), { initialProps: { id: A } });
    await waitFor(() => expect(first.result.current.schemas.length).toBe(1));
    expect(mockListSchemas).toHaveBeenCalledTimes(1);
    first.unmount();

    // Fresh hook instance for the same connection — must seed from the cache.
    const second = renderHook(({ id }) => useSchemaTree(id), { initialProps: { id: A } });
    await waitFor(() => expect(second.result.current.schemas[0]?.name).toBe("public"));
    expect(mockListSchemas).toHaveBeenCalledTimes(1);
  });
});
