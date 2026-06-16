import { afterEach, describe, expect, it } from "vitest";
import {
  _resetDirtySummariesForTests,
  listAllDirtySummaries,
  listDirtySummaries,
  registerDirtySummary,
  unregisterDirtySummary,
} from "./useDirtySummary";

afterEach(() => {
  _resetDirtySummariesForTests();
});

describe("useDirtySummary registry", () => {
  it("returns nothing when no summaries are registered", () => {
    expect(listAllDirtySummaries()).toEqual([]);
    expect(listDirtySummaries("conn-1")).toEqual([]);
  });

  it("returns only summaries belonging to the queried connection", () => {
    registerDirtySummary("tab-a", { connectionId: "conn-1", label: "public.users" });
    registerDirtySummary("tab-b", { connectionId: "conn-1", label: "public.orders" });
    registerDirtySummary("tab-c", { connectionId: "conn-2", label: "public.events" });

    const conn1 = listDirtySummaries("conn-1");
    expect(conn1).toHaveLength(2);
    expect(conn1.map((s) => s.label).sort()).toEqual([
      "public.orders",
      "public.users",
    ]);

    const conn2 = listDirtySummaries("conn-2");
    expect(conn2).toHaveLength(1);
    expect(conn2[0]?.label).toBe("public.events");
  });

  it("unregister removes the entry", () => {
    registerDirtySummary("tab-a", { connectionId: "conn-1", label: "public.users" });
    expect(listDirtySummaries("conn-1")).toHaveLength(1);
    unregisterDirtySummary("tab-a");
    expect(listDirtySummaries("conn-1")).toHaveLength(0);
  });

  it("re-registering the same tabId replaces the previous entry", () => {
    registerDirtySummary("tab-a", { connectionId: "conn-1", label: "public.users" });
    registerDirtySummary("tab-a", { connectionId: "conn-1", label: "public.users_v2" });
    const list = listDirtySummaries("conn-1");
    expect(list).toHaveLength(1);
    expect(list[0]?.label).toBe("public.users_v2");
  });

  it("clean buffer reports nothing when no register call ever runs", () => {
    expect(listDirtySummaries("conn-1")).toEqual([]);
  });
});
