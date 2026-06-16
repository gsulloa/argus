import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, within } from "@testing-library/react";
import { DataGrid } from "./DataGrid";
import { useEditBuffer } from "./useEditBuffer";
import type { DataColumn } from "./types";

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

function Harness({ columns }: { columns: DataColumn[] }) {
  const buffer = useEditBuffer();
  return (
    <DataGrid
      columns={columns}
      rows={[]}
      pageSize={200}
      orderBy={[]}
      status="ready"
      nextError={null}
      reachedEnd={true}
      selection={{ anchor: null, active: null }}
      activeCell={null}
      bulkEditActive={false}
      isReadOnly={false}
      pkColumns={null}
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

describe("DataGrid headers", () => {
  it("renders the column name but no inline data_type chip", () => {
    const columns: DataColumn[] = [
      { name: "email", data_type: "text", ordinal_position: 1, is_nullable: true },
    ];
    const { container } = render(<Harness columns={columns} />);

    const headers = container.querySelectorAll("[role='columnheader']");
    expect(headers).toHaveLength(1);
    const header = headers[0] as HTMLElement;

    // Visible primary content is the name.
    expect(within(header).getByText("email")).toBeTruthy();
    // No descendant text content equals the data_type chip.
    expect(within(header).queryByText("text")).toBeNull();
    // Tooltip still surfaces the type.
    expect(header.getAttribute("title")).toBe("email : text");
  });
});
