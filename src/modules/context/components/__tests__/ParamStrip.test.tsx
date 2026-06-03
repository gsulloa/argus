import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { QueryParam } from "@/modules/context/types";
import { ParamStrip } from "../ParamStrip";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PARAMS_WITH_DEFAULTS: QueryParam[] = [
  { name: "since", type: "timestamp", default: "2026-01-01" },
  { name: "limit", type: "int", default: 50 },
];

const PARAMS_REQUIRED: QueryParam[] = [
  { name: "user_id", type: "uuid", default: null },
  { name: "limit", type: "int", default: 10 },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ParamStrip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders_one_input_per_param", () => {
    render(
      <ParamStrip
        params={PARAMS_WITH_DEFAULTS}
        values={{ since: "2026-01-01", limit: "50" }}
        onChange={vi.fn()}
        onInsert={vi.fn()}
        missingRequired={[]}
      />,
    );
    expect(screen.getByLabelText("since")).toBeInTheDocument();
    expect(screen.getByLabelText("limit")).toBeInTheDocument();
  });

  it("prefills_defaults", () => {
    render(
      <ParamStrip
        params={PARAMS_WITH_DEFAULTS}
        values={{ since: "2026-01-01", limit: "50" }}
        onChange={vi.fn()}
        onInsert={vi.fn()}
        missingRequired={[]}
      />,
    );
    expect(screen.getByLabelText<HTMLInputElement>("since").value).toBe("2026-01-01");
    expect(screen.getByLabelText<HTMLInputElement>("limit").value).toBe("50");
  });

  it("disables_insert_when_required_missing", () => {
    render(
      <ParamStrip
        params={PARAMS_REQUIRED}
        values={{ user_id: "", limit: "10" }}
        onChange={vi.fn()}
        onInsert={vi.fn()}
        missingRequired={["user_id"]}
      />,
    );
    const btn = screen.getByRole("button", { name: /insert into editor/i });
    expect(btn).toBeDisabled();
  });

  it("enables_insert_when_all_required_filled", () => {
    const onInsert = vi.fn();
    render(
      <ParamStrip
        params={PARAMS_REQUIRED}
        values={{ user_id: "some-uuid", limit: "10" }}
        onChange={vi.fn()}
        onInsert={onInsert}
        missingRequired={[]}
      />,
    );
    const btn = screen.getByRole("button", { name: /insert into editor/i });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onInsert).toHaveBeenCalledTimes(1);
  });
});
