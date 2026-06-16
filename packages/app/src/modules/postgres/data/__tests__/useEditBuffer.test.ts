import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useEditBuffer, buildRowKey } from "../useEditBuffer";
import type { EditValue, CellValue } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRowKey(id: number): string {
  return buildRowKey({ id: id as EditValue });
}

function makePk(id: number): Record<string, EditValue> {
  return { id: id as EditValue };
}

/** A simple original row: two columns ["col_a", "col_b"] with values ["orig_a", "orig_b"]. */
const ORIGINAL_COLUMNS = ["col_a", "col_b"];
function makeOriginalRow(id: number): CellValue[] {
  return [`orig_a_${id}`, `orig_b_${id}`] as CellValue[];
}

// ---------------------------------------------------------------------------
// Test 1: Bulk set-cell over 10 rows × 2 columns
// ---------------------------------------------------------------------------

describe("bulkSetCellEdit", () => {
  it("applies 10 rows × 2 columns in one dispatch and one undo reverts all", () => {
    const { result } = renderHook(() => useEditBuffer());

    const entries: Array<{
      rowKey: string;
      column: string;
      value: EditValue;
      pk: Record<string, EditValue>;
      originalRow: CellValue[] | null;
      originalColumns: string[] | null;
    }> = [];
    for (let i = 0; i < 10; i++) {
      const rowKey = makeRowKey(i);
      const pk = makePk(i);
      const originalRow = makeOriginalRow(i) as CellValue[];
      entries.push({
        rowKey,
        column: "col_a",
        value: "new_a" as EditValue,
        pk,
        originalRow,
        originalColumns: ORIGINAL_COLUMNS,
      });
      entries.push({
        rowKey,
        column: "col_b",
        value: "new_b" as EditValue,
        pk,
        originalRow,
        originalColumns: ORIGINAL_COLUMNS,
      });
    }

    act(() => {
      result.current.bulkSetCellEdit(entries);
    });

    // 10 rows, each with kind "update" and 2 changes.
    expect(result.current.rows.size).toBe(10);
    for (let i = 0; i < 10; i++) {
      const row = result.current.rows.get(makeRowKey(i));
      expect(row).toBeDefined();
      expect(row!.kind).toBe("update");
      expect(Object.keys(row!.changes).length).toBe(2);
      expect(row!.changes["col_a"]).toBe("new_a");
      expect(row!.changes["col_b"]).toBe("new_b");
    }

    // Dirty counts: 10 updates.
    expect(result.current.dirtyCounts.updates).toBe(10);
    expect(result.current.dirtyCounts.inserts).toBe(0);
    expect(result.current.dirtyCounts.deletes).toBe(0);

    // Single undo removes all 20 cell edits across 10 rows.
    act(() => {
      result.current.undo();
    });

    expect(result.current.rows.size).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Test 2: Entry whose value equals original is dropped
  // ---------------------------------------------------------------------------

  it("drops a cell edit when the value equals the original (same drop-if-equals logic as set-cell)", () => {
    const { result } = renderHook(() => useEditBuffer());

    // Row 0: col_a gets a value that matches its original ("orig_a_0").
    // Row 0: col_b gets a genuinely different value.
    const entries = [
      {
        rowKey: makeRowKey(0),
        column: "col_a",
        value: "orig_a_0" as EditValue, // equals original → should be dropped
        pk: makePk(0),
        originalRow: makeOriginalRow(0) ,
        originalColumns: ORIGINAL_COLUMNS,
      },
      {
        rowKey: makeRowKey(0),
        column: "col_b",
        value: "new_b" as EditValue,
        pk: makePk(0),
        originalRow: makeOriginalRow(0) ,
        originalColumns: ORIGINAL_COLUMNS,
      },
    ];

    act(() => {
      result.current.bulkSetCellEdit(entries);
    });

    // The row should be in the buffer because col_b is dirty.
    const row = result.current.rows.get(makeRowKey(0));
    expect(row).toBeDefined();
    // col_a must NOT be in changes (equals original).
    expect("col_a" in row!.changes).toBe(false);
    // col_b must be in changes.
    expect(row!.changes["col_b"]).toBe("new_b");

    // Single undo removes the row.
    act(() => {
      result.current.undo();
    });
    expect(result.current.rows.size).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Test 3: Empty entries array → no state change, no undo entry
  // ---------------------------------------------------------------------------

  it("no-ops on empty entries and pushes no undo entry", () => {
    const { result } = renderHook(() => useEditBuffer());

    // Pre-populate one update so we can confirm no additional undo is pushed.
    act(() => {
      result.current.setCellEdit({
        rowKey: makeRowKey(99),
        column: "col_a",
        value: "something" as EditValue,
        pk: makePk(99),
        originalRow: makeOriginalRow(99) ,
        originalColumns: ORIGINAL_COLUMNS,
      });
    });

    const rowsBefore = result.current.rows.size;

    act(() => {
      result.current.bulkSetCellEdit([]);
    });

    // No change in rows.
    expect(result.current.rows.size).toBe(rowsBefore);

    // One undo (for the setCellEdit above) should clear the one pre-populated row.
    act(() => {
      result.current.undo();
    });
    expect(result.current.rows.size).toBe(0);

    // A second undo should be a no-op (no undo entry was pushed for the empty bulk call).
    act(() => {
      result.current.undo();
    });
    expect(result.current.rows.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Bulk delete-toggle mixed selection
// ---------------------------------------------------------------------------

describe("bulkDeleteToggle", () => {
  it("handles a mixed selection: insert removal, clean server mark-delete, already-deleted undelete — one undo reverts all", () => {
    const { result } = renderHook(() => useEditBuffer());

    let insertKey: string;

    // Set up state before the bulk action:
    // 1. Add an insert row.
    act(() => {
      insertKey = result.current.addInsertRow({ col_a: "inserted" as EditValue });
    });

    // 2. Mark row 1 for delete so it counts as "already deleted".
    act(() => {
      result.current.markRowDelete(makeRowKey(1), makePk(1));
    });

    // Now 2 undo entries are on the stack (one for addInsertRow, one for markRowDelete).
    expect(result.current.rows.size).toBe(2); // insert row + deleted row 1

    // Snapshot state before bulk toggle.
    const insertEntry = result.current.rows.get(insertKey!);
    const deletedEntry = result.current.rows.get(makeRowKey(1));
    expect(insertEntry?.kind).toBe("insert");
    expect(deletedEntry?.kind).toBe("delete");

    // Bulk-delete-toggle entries:
    // - insertKey → source "insert", currently not deleted (currentlyDeleted false)
    // - row 2 → source "server", clean (not in buffer, not deleted), with pk
    // - row 1 → source "server", already deleted, currentlyDeleted true
    act(() => {
      result.current.bulkDeleteToggle([
        { rowKey: insertKey!, source: "insert", currentlyDeleted: false },
        { rowKey: makeRowKey(2), source: "server", pk: makePk(2), currentlyDeleted: false },
        { rowKey: makeRowKey(1), source: "server", pk: makePk(1), currentlyDeleted: true },
      ]);
    });

    // Insert row should be removed.
    expect(result.current.rows.has(insertKey!)).toBe(false);

    // Row 2 should now be marked delete.
    const row2 = result.current.rows.get(makeRowKey(2));
    expect(row2?.kind).toBe("delete");

    // Row 1 (previously deleted) should now be removed (undeleted).
    expect(result.current.rows.has(makeRowKey(1))).toBe(false);

    // Total rows: only row 2.
    expect(result.current.rows.size).toBe(1);

    // One undo should revert the entire bulk-delete-toggle (3 changes at once).
    act(() => {
      result.current.undo();
    });

    // After undo: insert row should be back, row 1 should be deleted again, row 2 gone.
    expect(result.current.rows.has(insertKey!)).toBe(true);
    expect(result.current.rows.get(makeRowKey(1))?.kind).toBe("delete");
    expect(result.current.rows.has(makeRowKey(2))).toBe(false);
    expect(result.current.rows.size).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Test 5: Empty entries array → no state change, no undo entry
  // ---------------------------------------------------------------------------

  it("no-ops on empty entries and pushes no undo entry", () => {
    const { result } = renderHook(() => useEditBuffer());

    act(() => {
      result.current.markRowDelete(makeRowKey(5), makePk(5));
    });

    const sizeBefore = result.current.rows.size;

    act(() => {
      result.current.bulkDeleteToggle([]);
    });

    // No change.
    expect(result.current.rows.size).toBe(sizeBefore);

    // One undo clears the markRowDelete.
    act(() => {
      result.current.undo();
    });
    expect(result.current.rows.size).toBe(0);

    // Second undo is a no-op (no entry for the empty bulk call).
    act(() => {
      result.current.undo();
    });
    expect(result.current.rows.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 6: Single-row methods still work after adding bulk methods
// ---------------------------------------------------------------------------

describe("single-row methods smoke test", () => {
  it("setCellEdit and undo still work correctly alongside bulk methods", () => {
    const { result } = renderHook(() => useEditBuffer());

    act(() => {
      result.current.setCellEdit({
        rowKey: makeRowKey(42),
        column: "col_a",
        value: "hello" as EditValue,
        pk: makePk(42),
        originalRow: makeOriginalRow(42) ,
        originalColumns: ORIGINAL_COLUMNS,
      });
    });

    expect(result.current.rows.size).toBe(1);
    const row = result.current.rows.get(makeRowKey(42));
    expect(row?.kind).toBe("update");
    expect(row?.changes["col_a"]).toBe("hello");
    expect(result.current.dirtyCounts.updates).toBe(1);

    act(() => {
      result.current.undo();
    });

    expect(result.current.rows.size).toBe(0);
    expect(result.current.dirtyCounts.updates).toBe(0);
  });
});
