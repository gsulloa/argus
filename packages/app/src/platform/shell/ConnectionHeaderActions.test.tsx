import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import React from "react";

// ---------------------------------------------------------------------------
// Mock engine modules — stubs only, no real implementations pulled in.
// ---------------------------------------------------------------------------

vi.mock("@/modules/postgres", () => ({
  POSTGRES_KIND: "postgres",
  SchemaPrimaryActions: () => React.createElement("span", { "data-testid": "postgres-primary" }),
  SchemaToolbar: () => React.createElement("span", { "data-testid": "postgres-toolbar" }),
}));

vi.mock("@/modules/mysql", () => ({
  MYSQL_KIND: "mysql",
  MysqlSchemaPrimaryActions: () => React.createElement("span", { "data-testid": "mysql-primary" }),
  MysqlSchemaToolbar: () => React.createElement("span", { "data-testid": "mysql-toolbar" }),
}));

vi.mock("@/modules/mssql", () => ({
  MSSQL_KIND: "mssql",
  MssqlSchemaPrimaryActions: () => React.createElement("span", { "data-testid": "mssql-primary" }),
  MssqlSchemaToolbar: () => React.createElement("span", { "data-testid": "mssql-toolbar" }),
}));

vi.mock("@/modules/athena", () => ({
  ATHENA_KIND: "athena",
  AthenaSchemaPrimaryActions: () => React.createElement("span", { "data-testid": "athena-primary" }),
  AthenaSchemaToolbar: () => React.createElement("span", { "data-testid": "athena-toolbar" }),
}));

vi.mock("@/modules/dynamo", () => ({
  DYNAMO_KIND: "dynamodb",
}));

vi.mock("@/modules/dynamo/tables", () => ({
  DynamoRefreshButton: () => React.createElement("span", { "data-testid": "dynamo-refresh" }),
}));

// ---------------------------------------------------------------------------
// Control what connections list the component sees.
// ---------------------------------------------------------------------------

let mockConnectionItems: { id: string; name: string; kind: string; params: Record<string, unknown>; group_id: null; sort_order: number; created_at: number; updated_at: number }[] = [];

vi.mock("@/platform/connection-registry/useConnections", () => ({
  useConnections: () => ({
    items: mockConnectionItems,
    loading: false,
    error: null,
  }),
}));

// Import after all mocks.
import { ConnectionHeaderActions } from "./ConnectionHeaderActions";

function makeConnection(kind: string) {
  return {
    id: "test-conn",
    name: "Test Connection",
    kind,
    params: {},
    group_id: null,
    sort_order: 1,
    created_at: 0,
    updated_at: 0,
  };
}

describe("ConnectionHeaderActions", () => {
  it("renders postgres primary + toolbar stubs for postgres kind", () => {
    mockConnectionItems = [makeConnection("postgres")];
    const { getByTestId } = render(
      React.createElement(ConnectionHeaderActions, { connectionId: "test-conn" })
    );
    expect(getByTestId("postgres-primary")).toBeDefined();
    expect(getByTestId("postgres-toolbar")).toBeDefined();
  });

  it("renders mysql primary + toolbar stubs for mysql kind", () => {
    mockConnectionItems = [makeConnection("mysql")];
    const { getByTestId } = render(
      React.createElement(ConnectionHeaderActions, { connectionId: "test-conn" })
    );
    expect(getByTestId("mysql-primary")).toBeDefined();
    expect(getByTestId("mysql-toolbar")).toBeDefined();
  });

  it("renders mssql primary + toolbar stubs for mssql kind", () => {
    mockConnectionItems = [makeConnection("mssql")];
    const { getByTestId } = render(
      React.createElement(ConnectionHeaderActions, { connectionId: "test-conn" })
    );
    expect(getByTestId("mssql-primary")).toBeDefined();
    expect(getByTestId("mssql-toolbar")).toBeDefined();
  });

  it("renders athena primary + toolbar stubs for athena kind", () => {
    mockConnectionItems = [makeConnection("athena")];
    const { getByTestId } = render(
      React.createElement(ConnectionHeaderActions, { connectionId: "test-conn" })
    );
    expect(getByTestId("athena-primary")).toBeDefined();
    expect(getByTestId("athena-toolbar")).toBeDefined();
  });

  it("renders only DynamoRefreshButton for dynamodb kind", () => {
    mockConnectionItems = [makeConnection("dynamodb")];
    const { getByTestId, queryByTestId } = render(
      React.createElement(ConnectionHeaderActions, { connectionId: "test-conn" })
    );
    expect(getByTestId("dynamo-refresh")).toBeDefined();
    expect(queryByTestId("postgres-primary")).toBeNull();
    expect(queryByTestId("mysql-primary")).toBeNull();
  });

  it("renders nothing for an unknown kind (e.g. cloudwatch)", () => {
    mockConnectionItems = [makeConnection("cloudwatch")];
    const { container } = render(
      React.createElement(ConnectionHeaderActions, { connectionId: "test-conn" })
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when connectionId is not found", () => {
    mockConnectionItems = [];
    const { container } = render(
      React.createElement(ConnectionHeaderActions, { connectionId: "nonexistent" })
    );
    expect(container.firstChild).toBeNull();
  });
});
