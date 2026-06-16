import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { DataGrid, type DataGridHandle } from "./DataGrid";
import { useEditBuffer } from "./useEditBuffer";
import type { CellValue, DataColumn } from "./types";

vi.mock("@/platform/settings/api", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => true);
});

afterEach(() => {
  vi.clearAllMocks();
});

const columns: DataColumn[] = [
  { name: "id", data_type: "int4", ordinal_position: 1, is_nullable: false },
];

const rows = Array.from({ length: 50 }, (_, i) => ({
  rowKey: String(i),
  cells: [i + 1] as CellValue[],
  source: "server" as const,
}));

function Harness({ gridRef }: { gridRef: React.Ref<DataGridHandle> }) {
  const buffer = useEditBuffer();
  return (
    <DataGrid
      ref={gridRef}
      columns={columns}
      rows={rows}
      pageSize={200}
      orderBy={[]}
      status="ready"
      nextError={null}
      reachedEnd={true}
      selection={{ anchor: null, active: null }}
      activeCell={null}
      bulkEditActive={false}
      isReadOnly={false}
      pkColumns={["id"]}
      enumValuesByColumn={{}}
      buffer={buffer}
      connectionId="conn-1"
      schema="public"
      relation="users"
      onSelectionChange={() => {}}
      onActiveCellChange={() => {}}
      onSortChange={() => {}}
      onLoadNextPage={() => {}}
      onRetryNextPage={() => {}}
    />
  );
}

describe("DataGrid scrollToTop", () => {
  it("imperative ref resets the viewport's scrollTop to 0", () => {
    const ref = createRef<DataGridHandle>();
    const { container } = render(<Harness gridRef={ref} />);

    // The root has tabIndex=0; its only child is the viewport.
    const root = container.querySelector("[tabindex='0']") as HTMLDivElement;
    expect(root).toBeTruthy();
    const viewport = root.firstElementChild as HTMLDivElement;
    expect(viewport).toBeTruthy();

    viewport.scrollTop = 500;
    expect(viewport.scrollTop).toBe(500);

    act(() => {
      ref.current?.scrollToTop();
    });

    expect(viewport.scrollTop).toBe(0);
  });
});
