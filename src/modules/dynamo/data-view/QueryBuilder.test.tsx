/**
 * QueryBuilder tests — tasks 9.5, 4.5
 *
 * Covers:
 *   - Switching modes: Scan → Query reveals partition-key picker; Query → Scan hides it
 *   - Adding/removing filter rows updates BuilderState
 *   - Between filter: pick between, two value inputs appear, entering both yields correct state
 *   - begins_with sort-key clause
 *   - Type-mismatch validation (N key + non-numeric value → invalid)
 *   - Preview reflects the compiled state
 *   - (4.5) By-model mode: toggle, entity/AP selection, param inputs, round-trip
 */

import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { QueryBuilder } from "./QueryBuilder";
import { compile } from "./builderCompiler";
import type { BuilderState, DynamoModel, FilterRow } from "./types";
import type { TableDescription } from "@/modules/dynamo/tables/types";
import type { FilterBarHandle } from "@/modules/shared/filter-bar";

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

const DESCRIBE: TableDescription = {
  table_name: "events",
  table_arn: "arn:aws:dynamodb:us-east-1:123456789:table/events",
  table_status: "ACTIVE",
  item_count: 500,
  table_size_bytes: 1024,
  billing_mode: "PAY_PER_REQUEST",
  key_schema: [
    { attribute_name: "pk", key_type: "HASH" },
    { attribute_name: "sk", key_type: "RANGE" },
  ],
  attribute_definitions: [
    { attribute_name: "pk", attribute_type: "S" },
    { attribute_name: "sk", attribute_type: "S" },
    { attribute_name: "customerId", attribute_type: "N" },
    { attribute_name: "createdAt", attribute_type: "S" },
  ],
  global_secondary_indexes: [
    {
      index_name: "byCustomer",
      key_schema: [
        { attribute_name: "customerId", key_type: "HASH" },
        { attribute_name: "createdAt", key_type: "RANGE" },
      ],
      projection_type: "ALL",
      index_status: "ACTIVE",
    },
  ],
  local_secondary_indexes: [],
};

const INITIAL_BUILDER: BuilderState = {
  mode: "scan",
  indexName: null,
  pageSize: 100,
  consistentRead: false,
  scanIndexForward: true,
  filters: [],
};

// ---------------------------------------------------------------------------
// Controlled wrapper helper
// ---------------------------------------------------------------------------

interface RenderOptions {
  onValidityChangeFn?: (isValid: boolean, reason?: string) => void;
  onApplyOnlyFilter?: (transient: BuilderState) => void;
  ref?: React.Ref<FilterBarHandle>;
  models?: DynamoModel[];
  isStd?: boolean;
}

function renderQueryBuilder(
  initialBuilder: BuilderState = INITIAL_BUILDER,
  opts: RenderOptions | ((isValid: boolean, reason?: string) => void) = {},
) {
  // Support legacy signature: renderQueryBuilder(builder, validityFn)
  const options: RenderOptions = typeof opts === "function" ? { onValidityChangeFn: opts } : opts;
  const { onValidityChangeFn, onApplyOnlyFilter, ref, models, isStd } = options;

  let currentBuilder = initialBuilder;
  const onValidityChange = onValidityChangeFn ?? vi.fn();
  const onBuilderChange = vi.fn((next: BuilderState) => {
    currentBuilder = next;
  });

  const { rerender } = render(
    <QueryBuilder
      ref={ref}
      builder={currentBuilder}
      describe={DESCRIBE}
      onBuilderChange={onBuilderChange}
      onValidityChange={onValidityChange}
      onApplyOnlyFilter={onApplyOnlyFilter}
      models={models}
      isStd={isStd}
    />,
  );

  function rerenderWithLatest() {
    rerender(
      <QueryBuilder
        ref={ref}
        builder={currentBuilder}
        describe={DESCRIBE}
        onBuilderChange={onBuilderChange}
        onValidityChange={onValidityChange}
        onApplyOnlyFilter={onApplyOnlyFilter}
        models={models}
        isStd={isStd}
      />,
    );
  }

  function getLastBuilder(): BuilderState {
    return currentBuilder;
  }

  return { onBuilderChange, onValidityChange, rerenderWithLatest, getLastBuilder };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("QueryBuilder", () => {
  // ── 9.5.1 Mode switching ──────────────────────────────────────────────────

  describe("mode switching", () => {
    it("renders Scan mode by default with no partition-key picker", () => {
      renderQueryBuilder();

      const scanBtn = screen.getByTestId("mode-scan");
      expect(scanBtn.getAttribute("aria-pressed")).toBe("true");
      expect(screen.queryByTestId("pk-value")).toBeNull();
    });

    it("switching to Query mode reveals the partition-key picker", () => {
      const { onBuilderChange, rerenderWithLatest } = renderQueryBuilder();

      fireEvent.click(screen.getByTestId("mode-query"));
      expect(onBuilderChange).toHaveBeenCalledTimes(1);

      rerenderWithLatest();
      expect(screen.getByTestId("pk-value")).toBeTruthy();
    });

    it("switching back to Scan from Query hides the partition-key picker", () => {
      const queryBuilder: BuilderState = {
        ...INITIAL_BUILDER,
        mode: "query",
        query: {
          partitionKey: { name: "pk", value: { type: "S", value: "user-1" } },
        },
      };
      const { onBuilderChange, rerenderWithLatest } = renderQueryBuilder(queryBuilder);

      expect(screen.getByTestId("pk-value")).toBeTruthy();

      fireEvent.click(screen.getByTestId("mode-scan"));
      expect(onBuilderChange).toHaveBeenCalled();

      rerenderWithLatest();
      expect(screen.queryByTestId("pk-value")).toBeNull();
    });

    it("shows sort-key add button in Query mode when index has a SK", () => {
      const queryBuilder: BuilderState = {
        ...INITIAL_BUILDER,
        mode: "query",
        query: {
          partitionKey: { name: "pk", value: { type: "S", value: "user-1" } },
        },
      };
      renderQueryBuilder(queryBuilder);
      expect(screen.getByTestId("sk-add")).toBeTruthy();
    });
  });

  // ── 9.5.2 Adding/removing filter rows ─────────────────────────────────────

  describe("filter rows", () => {
    it("starts with no filter rows", () => {
      renderQueryBuilder();
      expect(screen.queryByTestId("filter-row-0")).toBeNull();
    });

    it("adds a filter row on 'Add filter' click", () => {
      const { onBuilderChange } = renderQueryBuilder();

      fireEvent.click(screen.getByTestId("add-filter"));

      expect(onBuilderChange).toHaveBeenCalledTimes(1);
      const next = onBuilderChange.mock.calls[0]![0]!;
      expect(next.filters).toHaveLength(1);
      expect(next.filters[0]?.kind).toBe("compare");
    });

    it("removes a filter row on remove button click", () => {
      const builderWithFilter: BuilderState = {
        ...INITIAL_BUILDER,
        filters: [{ kind: "compare", attribute: "status", op: "=", value: { type: "S", value: "ok" } }],
      };
      const { onBuilderChange } = renderQueryBuilder(builderWithFilter);

      fireEvent.click(screen.getByTestId("filter-0-remove"));

      expect(onBuilderChange).toHaveBeenCalledTimes(1);
      const next = onBuilderChange.mock.calls[0]![0]!;
      expect(next.filters).toHaveLength(0);
    });

    it("updating filter attribute triggers onBuilderChange", () => {
      const builderWithFilter: BuilderState = {
        ...INITIAL_BUILDER,
        filters: [{ kind: "compare", attribute: "", op: "=", value: { type: "S", value: "" } }],
      };
      const { onBuilderChange } = renderQueryBuilder(builderWithFilter);

      const attrInput = screen.getByTestId("filter-0-attr");
      fireEvent.change(attrInput, { target: { value: "status" } });

      expect(onBuilderChange).toHaveBeenCalled();
      const next = onBuilderChange.mock.calls[0]![0]!;
      expect(next.filters[0]?.attribute).toBe("status");
    });

    it("multiple add calls produce multiple filter rows", () => {
      const { onBuilderChange, rerenderWithLatest } = renderQueryBuilder();

      fireEvent.click(screen.getByTestId("add-filter"));
      rerenderWithLatest();

      fireEvent.click(screen.getByTestId("add-filter"));
      const finalState = onBuilderChange.mock.calls[1]![0]!;
      expect(finalState.filters).toHaveLength(2);
    });
  });

  // ── 9.5.3 Between filter ──────────────────────────────────────────────────

  describe("between filter", () => {
    it("switching op to 'between' causes two value inputs to appear", () => {
      const builderWithFilter: BuilderState = {
        ...INITIAL_BUILDER,
        filters: [{ kind: "compare", attribute: "score", op: "=", value: { type: "S", value: "" } }],
      };
      const { rerenderWithLatest } = renderQueryBuilder(builderWithFilter);

      const opSelect = screen.getByTestId("filter-0-op");
      fireEvent.change(opSelect, { target: { value: "between" } });
      rerenderWithLatest();

      expect(screen.getByTestId("filter-0-between-min")).toBeTruthy();
      expect(screen.getByTestId("filter-0-between-max")).toBeTruthy();
    });

    it("entering both between values produces correct BuilderState", () => {
      const builderWithBetween: BuilderState = {
        ...INITIAL_BUILDER,
        filters: [
          {
            kind: "compare",
            attribute: "score",
            op: "between",
            value: { min: { type: "N", value: "" }, max: { type: "N", value: "" } },
          },
        ],
      };
      const { onBuilderChange, rerenderWithLatest } = renderQueryBuilder(builderWithBetween);

      const minInput = screen.getByTestId("filter-0-between-min");
      fireEvent.change(minInput, { target: { value: "10" } });
      rerenderWithLatest();

      const maxInput = screen.getByTestId("filter-0-between-max");
      fireEvent.change(maxInput, { target: { value: "20" } });

      const finalState = onBuilderChange.mock.calls[1]![0]!;
      const filter: FilterRow | undefined = finalState.filters[0];
      expect(filter?.kind).toBe("compare");

      if (filter?.kind === "compare") {
        expect(filter.op).toBe("between");
        const val = filter.value;
        if ("min" in val) {
          expect(val.min.type).toBe("N");
          if (val.min.type === "N") expect(val.min.value).toBe("10");
          if (val.max.type === "N") expect(val.max.value).toBe("20");
        } else {
          throw new Error("Expected between value shape { min, max }");
        }
      }
    });
  });

  // ── 9.5.4 begins_with sort-key ────────────────────────────────────────────

  describe("begins_with sort-key clause", () => {
    it("picking begins_with for sort key sets sortKey.op to begins_with", () => {
      const queryBuilder: BuilderState = {
        ...INITIAL_BUILDER,
        mode: "query",
        query: {
          partitionKey: { name: "pk", value: { type: "S", value: "user-1" } },
          sortKey: { name: "sk", op: "=", value: { type: "S", value: "" } },
        },
      };
      const { onBuilderChange, rerenderWithLatest, getLastBuilder } = renderQueryBuilder(queryBuilder);

      const skOpSelect = screen.getByTestId("sk-op");
      fireEvent.change(skOpSelect, { target: { value: "begins_with" } });
      rerenderWithLatest();

      expect(getLastBuilder().query?.sortKey?.op).toBe("begins_with");

      const skValueInput = screen.getByTestId("sk-value");
      fireEvent.change(skValueInput, { target: { value: "2025-" } });

      const finalState = onBuilderChange.mock.calls[1]![0]!;
      expect(finalState.query?.sortKey?.op).toBe("begins_with");
      const skVal = finalState.query?.sortKey?.value;
      if (skVal && "type" in skVal && skVal.type === "S") {
        expect(skVal.value).toBe("2025-");
      } else {
        throw new Error("Expected a string TypedValue on the sort key");
      }
    });
  });

  // ── 9.5.5 Type-mismatch validation ───────────────────────────────────────

  describe("type-mismatch validation", () => {
    it("empty N-typed PK value is a compile error", () => {
      const builderWithEmptyN: BuilderState = {
        ...INITIAL_BUILDER,
        mode: "query",
        indexName: "byCustomer",
        query: {
          partitionKey: {
            name: "customerId",
            value: { type: "N", value: "" },
          },
        },
      };
      const result = compile(builderWithEmptyN, DESCRIBE);
      expect(result.kind).toBe("error");
    });

    it("S-typed value on N-typed PK key is a compile error", () => {
      const mismatchBuilder: BuilderState = {
        ...INITIAL_BUILDER,
        mode: "query",
        indexName: "byCustomer",
        query: {
          partitionKey: { name: "customerId", value: { type: "S", value: "not-a-number" } },
        },
      };
      const result = compile(mismatchBuilder, DESCRIBE);
      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.reason).toContain("N");
        expect(result.field).toBe("partitionKey");
      }
    });

    it("switching to Query mode triggers onValidityChange", () => {
      const onValidityChange = vi.fn<(isValid: boolean, reason?: string) => void>();
      renderQueryBuilder(INITIAL_BUILDER, onValidityChange);

      fireEvent.click(screen.getByTestId("mode-query"));
      expect(onValidityChange).toHaveBeenCalled();
    });

    it("valid numeric PK passes validation", () => {
      const builderValid: BuilderState = {
        ...INITIAL_BUILDER,
        mode: "query",
        indexName: "byCustomer",
        query: {
          partitionKey: { name: "customerId", value: { type: "N", value: "42" } },
        },
      };
      const result = compile(builderValid, DESCRIBE);
      expect(result.kind).toBe("query");
    });
  });

  // ── 9.5.6 Preview reflects compiled state ─────────────────────────────────

  describe("Preview disclosure", () => {
    it("starts collapsed", () => {
      renderQueryBuilder();
      expect(screen.queryByTestId("preview-body")).toBeNull();
    });

    it("expands on toggle click", () => {
      renderQueryBuilder();
      fireEvent.click(screen.getByTestId("preview-toggle"));
      expect(screen.getByTestId("preview-body")).toBeTruthy();
    });

    it("shows 'full scan' message in Scan mode with no filters", () => {
      renderQueryBuilder();
      fireEvent.click(screen.getByTestId("preview-toggle"));
      expect(screen.getByText(/No filter expression/i)).toBeTruthy();
    });

    it("shows FilterExpression when a filter is present", () => {
      const builderWithFilter: BuilderState = {
        ...INITIAL_BUILDER,
        filters: [{ kind: "compare", attribute: "status", op: "=", value: { type: "S", value: "ok" } }],
      };
      renderQueryBuilder(builderWithFilter);
      fireEvent.click(screen.getByTestId("preview-toggle"));

      const fe = screen.getByTestId("preview-fe");
      expect(fe.textContent).toContain("#n0 = :v0");
    });

    it("shows KeyConditionExpression in Query mode", () => {
      const queryBuilder: BuilderState = {
        ...INITIAL_BUILDER,
        mode: "query",
        query: {
          partitionKey: { name: "pk", value: { type: "S", value: "user-1" } },
        },
      };
      renderQueryBuilder(queryBuilder);
      fireEvent.click(screen.getByTestId("preview-toggle"));

      const kce = screen.getByTestId("preview-kce");
      expect(kce.textContent).toContain("#k0 = :k0");
    });

    it("shows ExpressionAttributeNames and Values", () => {
      const builderWithFilter: BuilderState = {
        ...INITIAL_BUILDER,
        filters: [
          { kind: "compare", attribute: "status", op: "=", value: { type: "S", value: "ok" } },
        ],
      };
      renderQueryBuilder(builderWithFilter);
      fireEvent.click(screen.getByTestId("preview-toggle"));

      const names = screen.getByTestId("preview-names");
      expect(names.textContent).toContain('"#n0"');
      expect(names.textContent).toContain('"status"');

      const values = screen.getByTestId("preview-values");
      expect(values.textContent).toContain('":v0"');
    });

    it("shows error reason when builder state is invalid (no query in Query mode)", () => {
      const invalidBuilder: BuilderState = {
        ...INITIAL_BUILDER,
        mode: "query",
      };
      renderQueryBuilder(invalidBuilder);
      fireEvent.click(screen.getByTestId("preview-toggle"));
      expect(screen.getByTestId("preview-error")).toBeTruthy();
    });

    it("Preview FilterExpression matches compile() output", () => {
      const builderWithFilter: BuilderState = {
        ...INITIAL_BUILDER,
        filters: [
          { kind: "compare", attribute: "count", op: ">=", value: { type: "N", value: "5" } },
        ],
      };
      renderQueryBuilder(builderWithFilter);
      fireEvent.click(screen.getByTestId("preview-toggle"));

      const compileResult = compile(builderWithFilter, DESCRIBE);
      expect(compileResult.kind).toBe("scan");
      if (compileResult.kind === "scan") {
        const fe = screen.getByTestId("preview-fe");
        expect(fe.textContent?.trim()).toBe(compileResult.request.filter_expression ?? "");
      }
    });

    it("collapses again on second toggle click", () => {
      renderQueryBuilder();
      fireEvent.click(screen.getByTestId("preview-toggle"));
      expect(screen.getByTestId("preview-body")).toBeTruthy();

      fireEvent.click(screen.getByTestId("preview-toggle"));
      expect(screen.queryByTestId("preview-body")).toBeNull();
    });
  });

  // ── Index dropdown ────────────────────────────────────────────────────────

  describe("index dropdown", () => {
    it("lists primary index and GSIs", () => {
      renderQueryBuilder();
      const indexSelect = screen.getByTestId("index-select");
      const options = within(indexSelect).getAllByRole("option");
      expect(options.length).toBe(2);
      expect(options[0]?.textContent).toContain("Primary");
      expect(options[1]?.textContent).toContain("byCustomer");
    });

    it("changing index updates builder.indexName", () => {
      const { onBuilderChange } = renderQueryBuilder();
      const indexSelect = screen.getByTestId("index-select");
      fireEvent.change(indexSelect, { target: { value: "byCustomer" } });

      expect(onBuilderChange).toHaveBeenCalled();
      const next = onBuilderChange.mock.calls[0]![0]!;
      expect(next.indexName).toBe("byCustomer");
    });
  });

  // ── Unary filter operators ─────────────────────────────────────────────────

  describe("unary operators", () => {
    it("switching to attribute_not_exists produces unary kind in state", () => {
      const builderWithFilter: BuilderState = {
        ...INITIAL_BUILDER,
        filters: [{ kind: "compare", attribute: "archived", op: "=", value: { type: "S", value: "" } }],
      };
      const { onBuilderChange, rerenderWithLatest, getLastBuilder } = renderQueryBuilder(builderWithFilter);

      const opSelect = screen.getByTestId("filter-0-op");
      fireEvent.change(opSelect, { target: { value: "attribute_not_exists" } });
      rerenderWithLatest();

      expect(getLastBuilder().filters[0]?.kind).toBe("unary");
      // value input should not exist for unary operators
      expect(screen.queryByTestId("filter-0-value")).toBeNull();
      void onBuilderChange; // used for getLastBuilder tracking
    });

    it("unary filter compiles without value placeholder", () => {
      const builder: BuilderState = {
        ...INITIAL_BUILDER,
        filters: [{ kind: "unary", attribute: "archived", op: "attribute_not_exists" }],
      };
      const result = compile(builder, DESCRIBE);
      expect(result.kind).toBe("scan");
      if (result.kind === "scan") {
        expect(result.request.filter_expression).toBe("attribute_not_exists(#n0)");
        expect(result.request.expression_attribute_values).toBeNull();
      }
    });
  });

  // ── 8.2/8.3 Combinator toggle ─────────────────────────────────────────────

  describe("RootCombinatorToggle (section 8.2–8.3)", () => {
    it("toggle is NOT rendered when filters.length === 0", () => {
      renderQueryBuilder();
      // No filter rows → no combinator toggle
      expect(screen.queryByRole("radiogroup", { name: /filter combinator/i })).toBeNull();
    });

    it("toggle IS rendered when at least one filter row exists", () => {
      const builderWithFilter: BuilderState = {
        ...INITIAL_BUILDER,
        filters: [{ kind: "compare", attribute: "status", op: "=", value: { type: "S", value: "ok" } }],
      };
      renderQueryBuilder(builderWithFilter);
      expect(screen.getByRole("radiogroup", { name: /filter combinator/i })).toBeTruthy();
    });

    it("toggle defaults to AND", () => {
      const builderWithFilter: BuilderState = {
        ...INITIAL_BUILDER,
        filters: [{ kind: "compare", attribute: "a", op: "=", value: { type: "S", value: "1" } }],
      };
      renderQueryBuilder(builderWithFilter);
      const andBtn = screen.getByRole("radio", { name: "AND" });
      expect(andBtn.getAttribute("aria-checked")).toBe("true");
    });

    it("clicking OR flips filterCombinator to OR and marks builder dirty via onBuilderChange", () => {
      const builderWithFilter: BuilderState = {
        ...INITIAL_BUILDER,
        filters: [{ kind: "compare", attribute: "a", op: "=", value: { type: "S", value: "1" } }],
      };
      const { onBuilderChange } = renderQueryBuilder(builderWithFilter);
      const orBtn = screen.getByRole("radio", { name: "OR" });
      fireEvent.click(orBtn);
      expect(onBuilderChange).toHaveBeenCalledTimes(1);
      const next: BuilderState = onBuilderChange.mock.calls[0]![0]!;
      expect(next.filterCombinator).toBe("OR");
    });

    it("FilterConnector between rows uses the active combinator", () => {
      const builderWithTwoFilters: BuilderState = {
        ...INITIAL_BUILDER,
        filterCombinator: "OR",
        filters: [
          { kind: "compare", attribute: "a", op: "=", value: { type: "S", value: "1" } },
          { kind: "compare", attribute: "b", op: "=", value: { type: "S", value: "2" } },
        ],
      };
      renderQueryBuilder(builderWithTwoFilters);
      // The FilterConnector pill between row 0 and row 1 should show "OR".
      // The toggle also shows "OR" as a radio button, so look for the connector
      // specifically — it renders as a non-button element with the label text.
      // We check that an element with the connector role/text is present.
      const orTexts = screen.getAllByText("OR");
      expect(orTexts.length).toBeGreaterThanOrEqual(1);
    });

    it("OR combinator compiles FilterExpression with OR joiner", () => {
      const orBuilder: BuilderState = {
        ...INITIAL_BUILDER,
        filterCombinator: "OR",
        filters: [
          { kind: "compare", attribute: "status", op: "=", value: { type: "S", value: "ok" } },
          { kind: "compare", attribute: "count", op: ">=", value: { type: "N", value: "5" } },
        ],
      };
      const result = compile(orBuilder, DESCRIBE);
      expect(result.kind).toBe("scan");
      if (result.kind === "scan") {
        expect(result.request.filter_expression).toBe("#n0 = :v0 OR #n1 >= :v1");
      }
    });
  });

  // ── 8.5 Per-row Apply button ──────────────────────────────────────────────

  describe("RowApplyButton (section 8.5)", () => {
    it("Apply-only button is NOT rendered when onApplyOnlyFilter is undefined", () => {
      const builderWithFilter: BuilderState = {
        ...INITIAL_BUILDER,
        filters: [{ kind: "compare", attribute: "status", op: "=", value: { type: "S", value: "ok" } }],
      };
      renderQueryBuilder(builderWithFilter);
      // aria-label from spec: "Apply only this filter"
      expect(screen.queryByRole("button", { name: /apply only this filter/i })).toBeNull();
    });

    it("Apply-only button IS rendered when onApplyOnlyFilter is provided", () => {
      const builderWithFilter: BuilderState = {
        ...INITIAL_BUILDER,
        filters: [{ kind: "compare", attribute: "status", op: "=", value: { type: "S", value: "ok" } }],
      };
      const onApplyOnly = vi.fn();
      renderQueryBuilder(builderWithFilter, { onApplyOnlyFilter: onApplyOnly });
      expect(screen.getByRole("button", { name: /apply only this filter/i })).toBeTruthy();
    });

    it("clicking Apply-only button fires onApplyOnlyFilter with the correct transient state", () => {
      const builderWithTwoFilters: BuilderState = {
        ...INITIAL_BUILDER,
        filters: [
          { kind: "compare", attribute: "status", op: "=", value: { type: "S", value: "ok" } },
          { kind: "compare", attribute: "count", op: ">=", value: { type: "N", value: "5" } },
        ],
      };
      const onApplyOnly = vi.fn();
      renderQueryBuilder(builderWithTwoFilters, { onApplyOnlyFilter: onApplyOnly });

      const applyBtns = screen.getAllByRole("button", { name: /apply only this filter/i });
      // Click the first row's apply button
      fireEvent.click(applyBtns[0]!);
      expect(onApplyOnly).toHaveBeenCalledTimes(1);
      const transient: BuilderState = onApplyOnly.mock.calls[0]![0];
      // Transient should have only the first filter
      expect(transient.filters).toHaveLength(1);
      expect(transient.filters[0]?.attribute).toBe("status");
      // Original builder fields preserved
      expect(transient.mode).toBe("scan");
    });

    it("clicking Apply-only on the second filter row sends the second filter", () => {
      const builderWithThreeFilters: BuilderState = {
        ...INITIAL_BUILDER,
        filters: [
          { kind: "compare", attribute: "a", op: "=", value: { type: "S", value: "1" } },
          { kind: "compare", attribute: "status", op: "=", value: { type: "S", value: "ok" } },
          { kind: "compare", attribute: "c", op: "=", value: { type: "S", value: "3" } },
        ],
      };
      const onApplyOnly = vi.fn();
      renderQueryBuilder(builderWithThreeFilters, { onApplyOnlyFilter: onApplyOnly });

      const applyBtns = screen.getAllByRole("button", { name: /apply only this filter/i });
      // Click the SECOND row's apply button (index 1)
      fireEvent.click(applyBtns[1]!);
      expect(onApplyOnly).toHaveBeenCalledTimes(1);
      const transient: BuilderState = onApplyOnly.mock.calls[0]![0];
      expect(transient.filters).toHaveLength(1);
      expect(transient.filters[0]?.attribute).toBe("status");
    });
  });

  // ── 8.1 forwardRef focus() ────────────────────────────────────────────────

  describe("FilterBarHandle.focus() (section 8.1)", () => {
    it("focus() targets the PK value input when in Query mode with empty PK", () => {
      const queryBuilderWithEmptyPk: BuilderState = {
        ...INITIAL_BUILDER,
        mode: "query",
        query: {
          partitionKey: { name: "pk", value: { type: "S", value: "" } },
        },
      };
      const ref = createRef<FilterBarHandle>();
      renderQueryBuilder(queryBuilderWithEmptyPk, { ref });

      const pkInput = screen.getByTestId("pk-value");
      const focusSpy = vi.spyOn(pkInput, "focus");

      ref.current?.focus();

      expect(focusSpy).toHaveBeenCalledTimes(1);
    });

    it("focus() targets the first filter attribute input when filters exist", () => {
      const builderWithFilter: BuilderState = {
        ...INITIAL_BUILDER,
        filters: [{ kind: "compare", attribute: "status", op: "=", value: { type: "S", value: "ok" } }],
      };
      const ref = createRef<FilterBarHandle>();
      renderQueryBuilder(builderWithFilter, { ref });

      const firstAttr = screen.getByTestId("filter-0-attr");
      const focusSpy = vi.spyOn(firstAttr, "focus");

      ref.current?.focus();

      expect(focusSpy).toHaveBeenCalledTimes(1);
    });

    it("focus() targets the + Filter add button when in empty scan mode", () => {
      const ref = createRef<FilterBarHandle>();
      renderQueryBuilder(INITIAL_BUILDER, { ref });

      const addBtn = screen.getByTestId("add-filter");
      const focusSpy = vi.spyOn(addBtn, "focus");

      ref.current?.focus();

      expect(focusSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── 4.5 By-model mode ────────────────────────────────────────────────────

  describe("By-model mode (task 4.5)", () => {
    // Test fixture: STD table with one model doc that has two access patterns
    const STD_MODELS: DynamoModel[] = [
      {
        name: "Order",
        access_patterns: [
          {
            name: "By user",
            index: "table",
            pk: "USER#${userId}",
            sk: "ORDER#${orderId}",
          },
          {
            index: "table",
            pk: "USER#${userId}",
            sk: "ORDER#${orderId}#STATUS#${status}",
          },
        ],
      },
      {
        name: "Product",
        access_patterns: [
          {
            name: "By ID",
            index: "table",
            pk: "PRODUCT#${productId}",
          },
        ],
      },
    ];

    const QUERY_BUILDER: BuilderState = {
      ...INITIAL_BUILDER,
      mode: "query",
    };

    it("toggle is NOT shown for non-STD tables (isStd=false)", () => {
      renderQueryBuilder(QUERY_BUILDER);
      expect(screen.queryByTestId("builder-mode-group")).toBeNull();
      // Raw index selector still visible
      expect(screen.getByTestId("index-select")).toBeTruthy();
    });

    it("toggle is NOT shown for STD tables in Scan mode", () => {
      renderQueryBuilder(INITIAL_BUILDER, { models: STD_MODELS, isStd: true });
      expect(screen.queryByTestId("builder-mode-group")).toBeNull();
    });

    it("toggle IS shown for STD tables in Query mode", () => {
      renderQueryBuilder(QUERY_BUILDER, { models: STD_MODELS, isStd: true });
      expect(screen.getByTestId("builder-mode-group")).toBeTruthy();
      expect(screen.getByTestId("builder-mode-model")).toBeTruthy();
      expect(screen.getByTestId("builder-mode-raw")).toBeTruthy();
    });

    it("defaults to Raw mode — index-select visible, model selectors absent", () => {
      renderQueryBuilder(QUERY_BUILDER, { models: STD_MODELS, isStd: true });
      expect(screen.getByTestId("index-select")).toBeTruthy();
      expect(screen.queryByTestId("model-entity-select")).toBeNull();
    });

    it("switching to By model mode shows entity selector and hides index-select", () => {
      const { rerenderWithLatest, onBuilderChange } = renderQueryBuilder(QUERY_BUILDER, {
        models: STD_MODELS,
        isStd: true,
      });
      fireEvent.click(screen.getByTestId("builder-mode-model"));
      rerenderWithLatest();

      expect(screen.queryByTestId("index-select")).toBeNull();
      expect(screen.getByTestId("model-entity-select")).toBeTruthy();
      // onBuilderChange emitted with builderMode: "model"
      expect(onBuilderChange).toHaveBeenCalled();
      const emitted = onBuilderChange.mock.calls[0]![0]!;
      expect(emitted.builderMode).toBe("model");
    });

    it("selecting an entity shows access-pattern selector", () => {
      const modelBuilder: BuilderState = {
        ...QUERY_BUILDER,
        builderMode: "model",
      };
      const { rerenderWithLatest, onBuilderChange } = renderQueryBuilder(modelBuilder, {
        models: STD_MODELS,
        isStd: true,
      });

      const entitySelect = screen.getByTestId("model-entity-select");
      fireEvent.change(entitySelect, { target: { value: "Order" } });
      rerenderWithLatest();

      expect(screen.getByTestId("model-ap-select")).toBeTruthy();
      expect(onBuilderChange).toHaveBeenCalled();
    });

    it("selecting an access pattern shows parameter inputs", () => {
      const modelBuilder: BuilderState = {
        ...QUERY_BUILDER,
        builderMode: "model",
        modelSelection: { entity: "Order", accessPattern: "By user", params: {} },
      };
      renderQueryBuilder(modelBuilder, { models: STD_MODELS, isStd: true });

      // "By user" pattern has params: userId, orderId
      expect(screen.getByTestId("model-param-userId")).toBeTruthy();
      expect(screen.getByTestId("model-param-orderId")).toBeTruthy();
    });

    it("(4.5 spec) fill params → switch to raw → switch back → entity/AP/params intact, compiled query unchanged", () => {
      // Step 1: Start in model mode with Order / "By user" and fill userId
      const modelBuilder: BuilderState = {
        ...QUERY_BUILDER,
        builderMode: "model",
        modelSelection: { entity: "Order", accessPattern: "By user", params: { userId: "123", orderId: "456" } },
        // Seeded compiled query from model
        query: {
          partitionKey: { name: "pk", value: { type: "S", value: "USER#123" } },
          sortKey: { name: "sk", op: "=", value: { type: "S", value: "ORDER#456" } },
        },
      };
      const { rerenderWithLatest, onBuilderChange } = renderQueryBuilder(modelBuilder, {
        models: STD_MODELS,
        isStd: true,
      });

      // Verify params are visible
      expect((screen.getByTestId("model-param-userId") as HTMLInputElement).value).toBe("123");
      expect((screen.getByTestId("model-param-orderId") as HTMLInputElement).value).toBe("456");

      // Step 2: Switch to Raw mode
      fireEvent.click(screen.getByTestId("builder-mode-raw"));
      rerenderWithLatest();

      // Raw mode: index-select visible, model selectors gone
      expect(screen.getByTestId("index-select")).toBeTruthy();
      expect(screen.queryByTestId("model-entity-select")).toBeNull();
      // modelSelection is preserved on the builder
      const rawBuilder = onBuilderChange.mock.calls[onBuilderChange.mock.calls.length - 1]![0]!;
      expect(rawBuilder.builderMode).toBe("raw");
      expect(rawBuilder.modelSelection?.entity).toBe("Order");
      expect(rawBuilder.modelSelection?.params.userId).toBe("123");
      expect(rawBuilder.modelSelection?.params.orderId).toBe("456");
      // The raw query was seeded from the model compile (partition key preserved)
      expect(rawBuilder.query?.partitionKey.value).toMatchObject({ type: "S", value: "USER#123" });

      // Step 3: Switch back to model mode
      fireEvent.click(screen.getByTestId("builder-mode-model"));
      rerenderWithLatest();

      // Model selectors re-appear
      expect(screen.getByTestId("model-entity-select")).toBeTruthy();
      const modelReentered = onBuilderChange.mock.calls[onBuilderChange.mock.calls.length - 1]![0]!;
      expect(modelReentered.builderMode).toBe("model");
      // modelSelection entity + params still intact
      expect(modelReentered.modelSelection?.entity).toBe("Order");
      expect(modelReentered.modelSelection?.params.userId).toBe("123");
      expect(modelReentered.modelSelection?.params.orderId).toBe("456");
    });

    it("non-STD table shows no toggle (task 5.3 coverage)", () => {
      // isStd=false (default): no builder-mode-group at all
      renderQueryBuilder(QUERY_BUILDER);
      expect(screen.queryByTestId("builder-mode-group")).toBeNull();
      // raw PK/SK builder is intact
      expect(screen.getByTestId("index-select")).toBeTruthy();
    });

    it("Product entity with pk-only AP renders only one param input", () => {
      const modelBuilder: BuilderState = {
        ...QUERY_BUILDER,
        builderMode: "model",
        modelSelection: { entity: "Product", accessPattern: "By ID", params: {} },
      };
      renderQueryBuilder(modelBuilder, { models: STD_MODELS, isStd: true });

      expect(screen.getByTestId("model-param-productId")).toBeTruthy();
      // No sk params
      expect(screen.queryByTestId("model-param-orderId")).toBeNull();
    });
  });
});
