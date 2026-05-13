/**
 * QueryBuilder tests — tasks 9.5
 *
 * Covers:
 *   - Switching modes: Scan → Query reveals partition-key picker; Query → Scan hides it
 *   - Adding/removing filter rows updates BuilderState
 *   - Between filter: pick between, two value inputs appear, entering both yields correct state
 *   - begins_with sort-key clause
 *   - Type-mismatch validation (N key + non-numeric value → invalid)
 *   - Preview reflects the compiled state
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { QueryBuilder } from "./QueryBuilder";
import { compile } from "./builderCompiler";
import type { BuilderState, FilterRow } from "./types";
import type { TableDescription } from "@/modules/dynamo/tables/types";

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

function renderQueryBuilder(
  initialBuilder: BuilderState = INITIAL_BUILDER,
  onValidityChangeFn?: (isValid: boolean, reason?: string) => void,
) {
  let currentBuilder = initialBuilder;
  const onValidityChange = onValidityChangeFn ?? vi.fn();
  const onBuilderChange = vi.fn((next: BuilderState) => {
    currentBuilder = next;
  });

  const { rerender } = render(
    <QueryBuilder
      builder={currentBuilder}
      describe={DESCRIBE}
      onBuilderChange={onBuilderChange}
      onValidityChange={onValidityChange}
    />,
  );

  function rerenderWithLatest() {
    rerender(
      <QueryBuilder
        builder={currentBuilder}
        describe={DESCRIBE}
        onBuilderChange={onBuilderChange}
        onValidityChange={onValidityChange}
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
});
