import { describe, expect, it } from "vitest";
import { listConnectionTabs } from "./connectionTabs";
import type { Tab } from "./types";

function makeTab(id: string, kind: string, payload: unknown): Tab {
  return { id, kind, title: id, closable: true, payload };
}

describe("listConnectionTabs", () => {
  // NOTE: postgres-query tabs no longer carry `connectionId` in their payload
  // (the connection is now runtime state, mutable via the toolbar selector).
  // Only tab kinds with a stable `connectionId` payload field (e.g. table-data)
  // are counted by listConnectionTabs.
  const tabs: Tab[] = [
    makeTab("welcome", "welcome", null),
    makeTab(
      "tv-1",
      "postgres-table-data",
      { connectionId: "conn-1", schema: "public", relation: "users" },
    ),
    makeTab(
      "tv-2",
      "postgres-table-data",
      { connectionId: "conn-1", schema: "public", relation: "orders" },
    ),
    makeTab(
      "sql-1",
      "postgres-query",
      { initialConnectionId: "conn-2", initialConnectionName: "analytics", initialSql: "" },
    ),
    makeTab("settings", "settings", { foo: "bar" }),
  ];

  it("returns tabs whose payload.connectionId matches", () => {
    const c1 = listConnectionTabs(tabs, "conn-1");
    expect(c1.map((t) => t.id)).toEqual(["tv-1", "tv-2"]);

    // postgres-query tabs use initialConnectionId (not connectionId) — they are
    // NOT included in connection tab counts since the connection is mutable.
    const c2 = listConnectionTabs(tabs, "conn-2");
    expect(c2.map((t) => t.id)).toEqual([]);
  });

  it("returns empty when no tab matches", () => {
    expect(listConnectionTabs(tabs, "missing")).toEqual([]);
  });

  it("ignores tabs without a connectionId in payload", () => {
    const result = listConnectionTabs(tabs, "conn-1");
    expect(result.find((t) => t.kind === "welcome")).toBeUndefined();
    expect(result.find((t) => t.kind === "settings")).toBeUndefined();
  });

  it("handles null/undefined payloads safely", () => {
    const weird: Tab[] = [
      makeTab("a", "x", null),
      makeTab("b", "x", undefined),
      makeTab("c", "x", { connectionId: "conn-1" }),
    ];
    expect(listConnectionTabs(weird, "conn-1").map((t) => t.id)).toEqual(["c"]);
  });
});
