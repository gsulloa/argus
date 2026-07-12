import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Capture the props passed to ContextQueriesBranch so we can assert the
// Workspace subtree wires an `onNewQuery` handler (the "New query" / new-file
// affordance only renders when this prop is present).
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const branchProps: any[] = [];
vi.mock("@/modules/context/components/ContextQueriesBranch", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ContextQueriesBranch: (props: any) => {
    branchProps.push(props);
    return null;
  },
}));

// Stub the per-engine schema trees but keep the real *_KIND constants that
// ConnectionSubtree compares against.
vi.mock("@/modules/postgres", async (io) => ({ ...(await io<object>()), SchemaTree: () => null }));
vi.mock("@/modules/mysql", async (io) => ({ ...(await io<object>()), MysqlSchemaTree: () => null }));
vi.mock("@/modules/mssql", async (io) => ({ ...(await io<object>()), MssqlSchemaTree: () => null }));
vi.mock("@/modules/dynamo/tables", () => ({ DynamoConnectionSubtree: () => null }));
vi.mock("@/modules/athena", async (io) => ({ ...(await io<object>()), AthenaSchemaTree: () => null }));
vi.mock("@/modules/cloudwatch", async (io) => ({ ...(await io<object>()), LogGroupsTree: () => null }));

vi.mock("@/modules/context/openContextQuery", () => ({
  openContextQuery: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/modules/context/api", () => ({
  contextApi: {
    saveQuery: vi.fn(() =>
      Promise.resolve({ name: "daily-report", rel_path: "reports/daily-report", folder: "reports" }),
    ),
  },
}));
vi.mock("@/platform/shell/tabs", () => ({ useTabs: () => ({}) }));
vi.mock("@/platform/toast", () => ({ useToast: () => ({ show: vi.fn() }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let items: any[] = [];
vi.mock("@/platform/connection-registry/useConnections", () => ({
  useConnections: () => ({ items }),
}));

import { ConnectionSubtree } from "./ConnectionSubtree";
import { POSTGRES_KIND } from "@/modules/postgres";
import { contextApi } from "@/modules/context/api";
import { openContextQuery } from "@/modules/context/openContextQuery";

describe("ConnectionSubtree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    branchProps.length = 0;
    items = [{ id: "c1", kind: POSTGRES_KIND, name: "PG", context_path: "/ctx" }];
  });

  it("passes an onNewQuery handler to the Postgres Context Queries branch", () => {
    render(<ConnectionSubtree connectionId="c1" />);
    const pgBranch = branchProps.find((p) => p.engine === "postgres");
    expect(pgBranch).toBeDefined();
    // The "New query" (new-file) button only renders when this is set.
    expect(typeof pgBranch.onNewQuery).toBe("function");
  });

  it("onNewQuery creates an empty query then opens it in a tab", async () => {
    render(<ConnectionSubtree connectionId="c1" />);
    const pgBranch = branchProps.find((p) => p.engine === "postgres");
    await pgBranch.onNewQuery("daily-report", "reports");
    expect(contextApi.saveQuery).toHaveBeenCalledWith("c1", "daily-report", "", { folder: "reports" });
    expect(openContextQuery).toHaveBeenCalledWith(
      expect.anything(),
      "c1",
      "PG",
      "postgres",
      expect.objectContaining({ path: "reports/daily-report", folder: "reports" }),
      expect.objectContaining({ setFocused: expect.any(Function), isOpen: expect.any(Function) }),
    );
  });
});
