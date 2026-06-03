import { describe, expect, it } from "vitest";
import {
  UNGROUPED_DROPPABLE_ID,
  resolveConnectionDropTarget,
} from "./dropResolution";
import type { Connection } from "@/platform/connection-registry/types";

function makeConn(id: string, groupId: string | null, sortOrder: number): Connection {
  return {
    id,
    name: id,
    kind: "postgres",
    params: {},
    group_id: groupId,
    sort_order: sortOrder,
    context_path: null,
    created_at: 0,
    updated_at: 0,
  };
}

const g1 = "group-1";
const g2 = "group-2";

describe("resolveConnectionDropTarget", () => {
  it("drop on group-header of an empty group returns dropIndex 0", () => {
    const byGroup = new Map([[g1, []]]);
    const result = resolveConnectionDropTarget(
      `group-header:${g1}`,
      "c-dragging",
      byGroup,
      [],
    );
    expect(result).toEqual({ groupId: g1, dropIndex: 0 });
  });

  it("drop on group-header of a non-empty group (dragging from elsewhere) appends at end", () => {
    const members = [makeConn("m1", g1, 1), makeConn("m2", g1, 2)];
    const byGroup = new Map([[g1, members]]);
    const result = resolveConnectionDropTarget(
      `group-header:${g1}`,
      "c-dragging",
      byGroup,
      [],
    );
    expect(result).toEqual({ groupId: g1, dropIndex: 2 });
  });

  it("drop on __ungrouped__ with 0 ungrouped returns dropIndex 0", () => {
    const result = resolveConnectionDropTarget(
      UNGROUPED_DROPPABLE_ID,
      "c-dragging",
      new Map(),
      [],
    );
    expect(result).toEqual({ groupId: null, dropIndex: 0 });
  });

  it("drop on __ungrouped__ with 3 ungrouped returns dropIndex 3", () => {
    const ungrouped = [
      makeConn("u1", null, 1),
      makeConn("u2", null, 2),
      makeConn("u3", null, 3),
    ];
    const result = resolveConnectionDropTarget(
      UNGROUPED_DROPPABLE_ID,
      "c-dragging",
      new Map(),
      ungrouped,
    );
    expect(result).toEqual({ groupId: null, dropIndex: 3 });
  });

  it("drop on row in same group above the dragging row returns correct dropIndex", () => {
    // rows: a(1), b(2), c(3) — dragging c, dropping on a (above c)
    // filtered (without c): [a, b] — overId=a → findIndex=0
    const rows = [
      makeConn("a", g1, 1),
      makeConn("b", g1, 2),
      makeConn("c", g1, 3),
    ];
    const byGroup = new Map([[g1, rows]]);
    const result = resolveConnectionDropTarget("a", "c", byGroup, []);
    expect(result).toEqual({ groupId: g1, dropIndex: 0 });
  });

  it("drop on row in same group below the dragging row returns correct dropIndex", () => {
    // rows: a(1), b(2), c(3) — dragging a, dropping on c (below a)
    // filtered (without a): [b, c] — overId=c → findIndex=1
    const rows = [
      makeConn("a", g1, 1),
      makeConn("b", g1, 2),
      makeConn("c", g1, 3),
    ];
    const byGroup = new Map([[g1, rows]]);
    const result = resolveConnectionDropTarget("c", "a", byGroup, []);
    expect(result).toEqual({ groupId: g1, dropIndex: 1 });
  });

  it("drop on row in another group returns that group's id and the row's index", () => {
    const g1Members = [makeConn("a", g1, 1), makeConn("b", g1, 2)];
    const g2Members = [makeConn("x", g2, 1), makeConn("y", g2, 2)];
    const byGroup = new Map([
      [g1, g1Members],
      [g2, g2Members],
    ]);
    // dragging "a" from g1, dropping on "y" in g2
    // filtered (y is not "a"): [x, y] — findIndex("y")=1
    const result = resolveConnectionDropTarget("y", "a", byGroup, []);
    expect(result).toEqual({ groupId: g2, dropIndex: 1 });
  });

  it("drop on self returns null", () => {
    const rows = [makeConn("a", g1, 1)];
    const byGroup = new Map([[g1, rows]]);
    const result = resolveConnectionDropTarget("a", "a", byGroup, []);
    expect(result).toBeNull();
  });

  it("drop on group-sortable id (tied droppable on header) is treated as drop on the same group's header", () => {
    const members = [makeConn("m1", g1, 1)];
    const byGroup = new Map([[g1, members]]);
    const result = resolveConnectionDropTarget(
      `group-sortable:${g1}`,
      "c-dragging",
      byGroup,
      [],
    );
    expect(result).toEqual({ groupId: g1, dropIndex: 1 });
  });

  it("drop on group-sortable id of an empty group lands at index 0", () => {
    const byGroup = new Map([[g1, []]]);
    const result = resolveConnectionDropTarget(
      `group-sortable:${g1}`,
      "c-dragging",
      byGroup,
      [],
    );
    expect(result).toEqual({ groupId: g1, dropIndex: 0 });
  });

  it("drop on unknown id returns null", () => {
    const byGroup = new Map([[g1, [makeConn("a", g1, 1)]]]);
    const result = resolveConnectionDropTarget("does-not-exist", "a", byGroup, []);
    expect(result).toBeNull();
  });
});
