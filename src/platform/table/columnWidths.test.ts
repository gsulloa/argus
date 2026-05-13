import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  baseWidthFor,
  clampWidth,
  useColumnWidths,
  BASE_WIDTH_BY_CATEGORY,
  MIN_WIDTH,
  MAX_WIDTH,
  KEY_BADGE_PAD,
  type ColumnCategory,
  type ColumnSpec,
} from "./columnWidths";

// ---------------------------------------------------------------------------
// baseWidthFor
// ---------------------------------------------------------------------------

describe("baseWidthFor", () => {
  const categories: ColumnCategory[] = [
    "boolean",
    "numeric",
    "date",
    "uuid",
    "text",
    "json",
    "binary",
    "other",
  ];

  for (const category of categories) {
    it(`returns ${BASE_WIDTH_BY_CATEGORY[category]} for category "${category}" without isKey`, () => {
      expect(baseWidthFor({ category })).toBe(BASE_WIDTH_BY_CATEGORY[category]);
    });

    it(`returns ${BASE_WIDTH_BY_CATEGORY[category] + KEY_BADGE_PAD} for category "${category}" with isKey=true`, () => {
      expect(baseWidthFor({ category, isKey: true })).toBe(
        BASE_WIDTH_BY_CATEGORY[category] + KEY_BADGE_PAD,
      );
    });
  }

  it("isKey=false is same as no isKey", () => {
    expect(baseWidthFor({ category: "text", isKey: false })).toBe(
      BASE_WIDTH_BY_CATEGORY.text,
    );
  });
});

// ---------------------------------------------------------------------------
// clampWidth
// ---------------------------------------------------------------------------

describe("clampWidth", () => {
  it("clamps below MIN_WIDTH up to MIN_WIDTH", () => {
    expect(clampWidth(30)).toBe(MIN_WIDTH); // 56
    expect(clampWidth(0)).toBe(MIN_WIDTH);
    expect(clampWidth(-100)).toBe(MIN_WIDTH);
  });

  it("clamps above MAX_WIDTH down to MAX_WIDTH", () => {
    expect(clampWidth(1200)).toBe(MAX_WIDTH); // 800
    expect(clampWidth(99999)).toBe(MAX_WIDTH);
  });

  it("leaves values in range unchanged", () => {
    expect(clampWidth(180)).toBe(180);
    expect(clampWidth(MIN_WIDTH)).toBe(MIN_WIDTH);
    expect(clampWidth(MAX_WIDTH)).toBe(MAX_WIDTH);
    expect(clampWidth(350)).toBe(350);
  });
});

// ---------------------------------------------------------------------------
// useColumnWidths — in-memory mode (storageKey === null)
// ---------------------------------------------------------------------------

describe("useColumnWidths — in-memory mode", () => {
  const columns: ColumnSpec[] = [
    { name: "id", category: "uuid" },
    { name: "status", category: "text" },
    { name: "created_at", category: "date" },
    { name: "active", category: "boolean" },
  ];

  it("widthFor returns type-derived defaults when no override exists", () => {
    const { result } = renderHook(() =>
      useColumnWidths({ storageKey: null, columns }),
    );
    expect(result.current.widthFor("id")).toBe(BASE_WIDTH_BY_CATEGORY.uuid); // 280
    expect(result.current.widthFor("status")).toBe(BASE_WIDTH_BY_CATEGORY.text); // 200
    expect(result.current.widthFor("created_at")).toBe(
      BASE_WIDTH_BY_CATEGORY.date,
    ); // 168
    expect(result.current.widthFor("active")).toBe(
      BASE_WIDTH_BY_CATEGORY.boolean,
    ); // 88
  });

  it("totalWidth equals sum of all default widths", () => {
    const { result } = renderHook(() =>
      useColumnWidths({ storageKey: null, columns }),
    );
    const expected =
      BASE_WIDTH_BY_CATEGORY.uuid +
      BASE_WIDTH_BY_CATEGORY.text +
      BASE_WIDTH_BY_CATEGORY.date +
      BASE_WIDTH_BY_CATEGORY.boolean;
    expect(result.current.totalWidth).toBe(expected);
  });

  it("setWidth updates widthFor and totalWidth", () => {
    const { result } = renderHook(() =>
      useColumnWidths({ storageKey: null, columns }),
    );

    act(() => result.current.setWidth("status", 350));

    expect(result.current.widthFor("status")).toBe(350);
    const expected =
      BASE_WIDTH_BY_CATEGORY.uuid +
      350 +
      BASE_WIDTH_BY_CATEGORY.date +
      BASE_WIDTH_BY_CATEGORY.boolean;
    expect(result.current.totalWidth).toBe(expected);
  });

  it("setWidth clamps before storing", () => {
    const { result } = renderHook(() =>
      useColumnWidths({ storageKey: null, columns }),
    );

    act(() => result.current.setWidth("status", 10)); // below MIN
    expect(result.current.widthFor("status")).toBe(MIN_WIDTH);

    act(() => result.current.setWidth("status", 9999)); // above MAX
    expect(result.current.widthFor("status")).toBe(MAX_WIDTH);
  });

  it("resetWidth clears the override and falls back to default", () => {
    const { result } = renderHook(() =>
      useColumnWidths({ storageKey: null, columns }),
    );

    act(() => result.current.setWidth("id", 400));
    expect(result.current.widthFor("id")).toBe(400);

    act(() => result.current.resetWidth("id"));
    expect(result.current.widthFor("id")).toBe(BASE_WIDTH_BY_CATEGORY.uuid);
  });

  it("isKey column gets KEY_BADGE_PAD added to default", () => {
    const cols: ColumnSpec[] = [{ name: "pk", category: "uuid", isKey: true }];
    const { result } = renderHook(() =>
      useColumnWidths({ storageKey: null, columns: cols }),
    );
    expect(result.current.widthFor("pk")).toBe(
      BASE_WIDTH_BY_CATEGORY.uuid + KEY_BADGE_PAD,
    );
  });

  it("fixedWidth takes priority over everything", () => {
    const cols: ColumnSpec[] = [
      { name: "more", category: "other", fixedWidth: 40 },
    ];
    const { result } = renderHook(() =>
      useColumnWidths({ storageKey: null, columns: cols }),
    );
    expect(result.current.widthFor("more")).toBe(40);

    // Even after a setWidth call, fixedWidth wins
    act(() => result.current.setWidth("more", 200));
    expect(result.current.widthFor("more")).toBe(40);
  });

  it("unknown column name falls back to 'other' base width", () => {
    const { result } = renderHook(() =>
      useColumnWidths({ storageKey: null, columns }),
    );
    expect(result.current.widthFor("nonexistent")).toBe(
      BASE_WIDTH_BY_CATEGORY.other,
    );
  });
});

// ---------------------------------------------------------------------------
// useColumnWidths — persisted mode (storageKey is a string)
// ---------------------------------------------------------------------------

describe("useColumnWidths — persisted mode", () => {
  const columns: ColumnSpec[] = [
    { name: "email", category: "text" },
    { name: "age", category: "numeric" },
  ];

  // In jsdom (non-Tauri) useSetting short-circuits to in-memory only,
  // so we can verify behavior without mocking Tauri IPC.
  it("uses default widths when no setting is stored", () => {
    const { result } = renderHook(() =>
      useColumnWidths({ storageKey: "test-key-fresh", columns }),
    );
    expect(result.current.widthFor("email")).toBe(BASE_WIDTH_BY_CATEGORY.text);
    expect(result.current.widthFor("age")).toBe(BASE_WIDTH_BY_CATEGORY.numeric);
  });

  it("setWidth persists via useSetting (in jsdom memory cache)", () => {
    const storageKey = "test-key-persist";
    const { result } = renderHook(() =>
      useColumnWidths({ storageKey, columns }),
    );

    act(() => result.current.setWidth("email", 320));
    expect(result.current.widthFor("email")).toBe(320);
  });

  it("setWidth clamps in persisted mode", () => {
    const { result } = renderHook(() =>
      useColumnWidths({ storageKey: "test-key-clamp", columns }),
    );

    act(() => result.current.setWidth("age", 5));
    expect(result.current.widthFor("age")).toBe(MIN_WIDTH);
  });

  it("resetWidth clears entry and reverts to type default in persisted mode", () => {
    const { result } = renderHook(() =>
      useColumnWidths({ storageKey: "test-key-reset", columns }),
    );

    act(() => result.current.setWidth("email", 400));
    expect(result.current.widthFor("email")).toBe(400);

    act(() => result.current.resetWidth("email"));
    expect(result.current.widthFor("email")).toBe(BASE_WIDTH_BY_CATEGORY.text);
  });

  it("totalWidth is sum of all effective widths", () => {
    const { result } = renderHook(() =>
      useColumnWidths({ storageKey: "test-key-total", columns }),
    );

    const defaultTotal =
      BASE_WIDTH_BY_CATEGORY.text + BASE_WIDTH_BY_CATEGORY.numeric;
    expect(result.current.totalWidth).toBe(defaultTotal);

    act(() => result.current.setWidth("age", 200));
    expect(result.current.totalWidth).toBe(BASE_WIDTH_BY_CATEGORY.text + 200);
  });
});
