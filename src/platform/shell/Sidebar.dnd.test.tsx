import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import React from "react";

// Capture the onDragEnd callback from the single DndContext.
const capturedOnDragEnd: { current: ((e: unknown) => void) | null } = {
  current: null,
};

vi.mock("@dnd-kit/core", async () => {
  const actual = await vi.importActual<typeof import("@dnd-kit/core")>(
    "@dnd-kit/core",
  );
  return {
    ...actual,
    DndContext: ({
      children,
      onDragEnd,
    }: {
      children: React.ReactNode;
      onDragEnd: (e: unknown) => void;
    }) => {
      capturedOnDragEnd.current = onDragEnd;
      return React.createElement(React.Fragment, null, children);
    },
    useDroppable: () => ({ setNodeRef: () => undefined, isOver: false }),
  };
});

vi.mock("@dnd-kit/sortable", async () => {
  const actual = await vi.importActual<typeof import("@dnd-kit/sortable")>(
    "@dnd-kit/sortable",
  );
  return {
    ...actual,
    SortableContext: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useSortable: () => ({
      attributes: {},
      listeners: {},
      setNodeRef: () => undefined,
      transform: null,
      transition: null,
      isDragging: false,
    }),
  };
});

const moveSpy = vi.fn().mockResolvedValue(undefined);
const refreshSpy = vi.fn().mockResolvedValue(undefined);

// Control what connections list the component sees.
let connectionItems = [
  {
    id: "c1",
    name: "Test",
    kind: "postgres",
    params: {},
    group_id: null as string | null,
    sort_order: 1,
    created_at: 0,
    updated_at: 0,
  },
];

vi.mock("@/platform/connection-registry/useConnections", () => ({
  useConnections: () => ({
    items: connectionItems,
    loading: false,
    error: null,
    move: moveSpy,
    refresh: refreshSpy,
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  }),
}));

vi.mock("@/platform/connection-registry/useConnectionGroups", () => ({
  useConnectionGroups: () => ({
    items: [
      {
        id: "g1",
        name: "Production",
        sort_order: 1,
        created_at: 0,
        updated_at: 0,
      },
    ],
    loading: false,
    error: null,
    refresh: refreshSpy,
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  }),
}));

vi.mock("@/platform/connection-registry/useExpandedGroups", () => ({
  useExpandedGroups: () => ({
    isExpanded: () => true,
    toggle: vi.fn(),
    setExpanded: vi.fn(),
  }),
}));

vi.mock("@/modules/postgres", () => ({
  usePostgresForm: () => ({
    openCreate: vi.fn(),
    openEdit: vi.fn(),
    openDuplicate: vi.fn(),
  }),
  useActiveConnections: () => ({ items: [], isActive: () => false }),
  postgresApi: { connect: vi.fn(), disconnect: vi.fn(), disconnectAll: vi.fn() },
  PostgresIcon: () => null,
  SchemaPrimaryActions: () => null,
  SchemaToolbar: () => null,
  SchemaTree: () => null,
  POSTGRES_KIND: "postgres",
}));

vi.mock("@/modules/query-history", () => ({
  openHistoryTab: vi.fn(),
}));

vi.mock("@/platform/shell/tabs", () => ({
  useTabs: () => ({
    tabs: [],
    activeTabId: null,
    open: vi.fn(),
    close: vi.fn(),
    activate: vi.fn(),
    move: vi.fn(),
    cycle: vi.fn(),
  }),
}));

vi.mock("@/assets/logo.svg", () => ({ default: "" }));

// Import after all mocks.
import { Sidebar } from "./Sidebar";

describe("Sidebar DnD — cross-section drops", () => {
  beforeEach(() => {
    capturedOnDragEnd.current = null;
    moveSpy.mockClear();
    refreshSpy.mockClear();
    // Reset to ungrouped connection by default.
    connectionItems = [
      {
        id: "c1",
        name: "Test",
        kind: "postgres",
        params: {},
        group_id: null,
        sort_order: 1,
        created_at: 0,
        updated_at: 0,
      },
    ];
  });

  it("drag ungrouped connection onto empty group header calls move with group_id", async () => {
    // c1 is ungrouped; g1 is empty.
    render(React.createElement(Sidebar));
    expect(capturedOnDragEnd.current).not.toBeNull();

    capturedOnDragEnd.current!({
      active: { id: "c1" },
      over: { id: "group-header:g1" },
    });

    await waitFor(() =>
      expect(moveSpy).toHaveBeenCalledWith("c1", {
        group_id: "g1",
        sort_order: expect.any(Number),
      }),
    );
  });

  it("drag grouped connection onto ungrouped header calls move with group_id null", async () => {
    // Repoint connectionItems to a grouped connection before render.
    connectionItems = [
      {
        id: "c2",
        name: "Grouped",
        kind: "postgres",
        params: {},
        group_id: "g1",
        sort_order: 1,
        created_at: 0,
        updated_at: 0,
      },
    ];

    render(React.createElement(Sidebar));
    expect(capturedOnDragEnd.current).not.toBeNull();

    capturedOnDragEnd.current!({
      active: { id: "c2" },
      over: { id: "__ungrouped__" },
    });

    await waitFor(() =>
      expect(moveSpy).toHaveBeenCalledWith("c2", {
        group_id: null,
        sort_order: expect.any(Number),
      }),
    );
  });
});
