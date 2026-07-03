import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import React from "react";

// ---------------------------------------------------------------------------
// Mock engine modules — stubs only, no real implementations pulled in.
// ---------------------------------------------------------------------------

vi.mock("@/modules/postgres", () => ({
  POSTGRES_KIND: "postgres",
}));
vi.mock("@/modules/mysql", () => ({
  MYSQL_KIND: "mysql",
}));
vi.mock("@/modules/mssql", () => ({
  MSSQL_KIND: "mssql",
}));
vi.mock("@/modules/athena", () => ({
  ATHENA_KIND: "athena",
}));
vi.mock("@/modules/dynamo", () => ({
  DYNAMO_KIND: "dynamodb",
}));
vi.mock("@/modules/cloudwatch", () => ({
  CLOUDWATCH_KIND: "cloudwatch",
}));

// Stub EngineIcon and ConnectionHeaderActions so they don't pull in heavy deps.
vi.mock("./ConnectionRail", () => ({
  EngineIcon: () => React.createElement("span", { "data-testid": "engine-icon" }),
  deriveEnv: (name: string) => (/prod/i.test(name) ? "prod" : "neutral"),
  engineLabel: (kind: string) => kind,
}));

vi.mock("./ConnectionHeaderActions", () => ({
  ConnectionHeaderActions: () =>
    React.createElement("span", { "data-testid": "header-actions" }),
}));

// ---------------------------------------------------------------------------
// Mock hooks
// ---------------------------------------------------------------------------

let mockConnectionItems: {
  id: string;
  name: string;
  kind: string;
  params: Record<string, unknown>;
  group_id: string | null;
  sort_order: number;
  context_path: string | null;
  project_source_path: string | null;
  color: string | null;
  created_at: number;
  updated_at: number;
}[] = [];

vi.mock("@/platform/connection-registry/useConnections", () => ({
  useConnections: () => ({
    items: mockConnectionItems,
    loading: false,
    error: null,
  }),
}));

vi.mock("@/platform/connection-registry/useConnectionGroups", () => ({
  useConnectionGroups: () => ({
    items: [],
    loading: false,
    error: null,
  }),
}));

vi.mock("@/modules/dynamo/useActiveConnections", () => ({
  useActiveDynamoConnections: () => ({
    getActive: () => undefined,
    isActive: () => false,
  }),
}));

// Import after all mocks.
import { ConnectionIdentityHeader } from "./WorkspaceShell";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConnection(color: string | null) {
  return {
    id: "conn-1",
    name: "Test Connection",
    kind: "postgres",
    params: {},
    group_id: null,
    sort_order: 1,
    context_path: null,
    project_source_path: null,
    color,
    created_at: 0,
    updated_at: 0,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConnectionIdentityHeader color accent", () => {
  it("colored connection (amber) gets data-colored=true and --header-accent inline style", () => {
    mockConnectionItems = [makeConnection("amber")];
    const { container } = render(
      React.createElement(ConnectionIdentityHeader, { connectionId: "conn-1" })
    );
    const header = container.firstElementChild as HTMLElement;
    expect(header).not.toBeNull();
    expect(header.getAttribute("data-colored")).toBe("true");
    expect(header.style.getPropertyValue("--header-accent")).toBeTruthy();
    expect(header.style.getPropertyValue("--header-accent")).toContain("conn-color-amber");
  });

  it("uncolored connection (null) has NO data-colored attribute and no --header-accent", () => {
    mockConnectionItems = [makeConnection(null)];
    const { container } = render(
      React.createElement(ConnectionIdentityHeader, { connectionId: "conn-1" })
    );
    const header = container.firstElementChild as HTMLElement;
    expect(header).not.toBeNull();
    expect(header.getAttribute("data-colored")).toBeNull();
    expect(header.style.getPropertyValue("--header-accent")).toBe("");
  });

  it("switching color connection from blue to red updates --header-accent", () => {
    mockConnectionItems = [makeConnection("blue")];
    const { container, rerender } = render(
      React.createElement(ConnectionIdentityHeader, { connectionId: "conn-1" })
    );

    const header = container.firstElementChild as HTMLElement;
    expect(header.getAttribute("data-colored")).toBe("true");
    const blueVar = header.style.getPropertyValue("--header-accent");
    expect(blueVar).toContain("conn-color-blue");

    // Switch to red
    mockConnectionItems = [makeConnection("red")];
    rerender(
      React.createElement(ConnectionIdentityHeader, { connectionId: "conn-1" })
    );

    expect(header.getAttribute("data-colored")).toBe("true");
    const redVar = header.style.getPropertyValue("--header-accent");
    expect(redVar).toContain("conn-color-red");
    expect(redVar).not.toBe(blueVar);
  });

  it("unknown/invalid color value has NO data-colored attribute", () => {
    // Simulate a stored value that is not in the palette
    mockConnectionItems = [makeConnection("hotpink")];
    const { container } = render(
      React.createElement(ConnectionIdentityHeader, { connectionId: "conn-1" })
    );
    const header = container.firstElementChild as HTMLElement;
    expect(header.getAttribute("data-colored")).toBeNull();
  });
});
