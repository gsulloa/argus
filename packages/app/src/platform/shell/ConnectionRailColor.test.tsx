/**
 * ConnectionRail color-derivation contract tests (Task 4b).
 *
 * ConnectionRail itself is heavily wired to Tauri context-menu / Radix UI
 * primitives and would require an extensive provider tree to render.  Per the
 * task spec, we cover the color-derivation contract directly: assert that
 * `isConnectionColor` / `connectionColorVar` gating produces the expected
 * data-attribute / style values that the rail template uses, and verify the
 * heuristic fallback path for uncolored connections.
 */
import { describe, expect, it } from "vitest";
import {
  isConnectionColor,
  connectionColorVar,
} from "@/platform/connection-registry/colors";

// ---------------------------------------------------------------------------
// Helpers — mirror the attribute-derivation logic from ConnectionRail.tsx
// ---------------------------------------------------------------------------

/** Derive the dot attributes exactly as ConnectionRail.tsx does. */
function deriveDotAttrs(colorValue: string | null | undefined, name: string) {
  const hasExplicitColor = isConnectionColor(colorValue);
  const dotStyle = hasExplicitColor
    ? { "--dot-color": connectionColorVar(colorValue!) }
    : undefined;
  const env = hasExplicitColor ? undefined : (/prod/i.test(name) ? "prod" : "neutral");
  const dataColor = hasExplicitColor ? colorValue : undefined;
  const dataEnv = env;

  return { hasExplicitColor, dotStyle, dataColor, dataEnv };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConnectionRail color-derivation contract", () => {
  it("colored connection (red): data-color is set, data-env is absent, --dot-color carries the var", () => {
    const { hasExplicitColor, dotStyle, dataColor, dataEnv } =
      deriveDotAttrs("red", "my-service-prod");

    expect(hasExplicitColor).toBe(true);
    expect(dataColor).toBe("red");
    expect(dataEnv).toBeUndefined();
    expect(dotStyle).toBeDefined();
    expect(dotStyle!["--dot-color"]).toBe("var(--conn-color-red)");
  });

  it("uncolored connection with prod name: data-color is absent, data-env is prod", () => {
    const { hasExplicitColor, dotStyle, dataColor, dataEnv } =
      deriveDotAttrs(null, "my-service-prod");

    expect(hasExplicitColor).toBe(false);
    expect(dataColor).toBeUndefined();
    expect(dataEnv).toBe("prod");
    expect(dotStyle).toBeUndefined();
  });

  it("uncolored connection with non-prod name: data-color is absent, data-env is neutral", () => {
    const { hasExplicitColor, dotStyle, dataColor, dataEnv } =
      deriveDotAttrs(null, "my-service-dev");

    expect(hasExplicitColor).toBe(false);
    expect(dataColor).toBeUndefined();
    expect(dataEnv).toBe("neutral");
    expect(dotStyle).toBeUndefined();
  });

  it("invalid/unknown color value is treated as uncolored — falls back to heuristic", () => {
    const { hasExplicitColor, dataColor, dataEnv } =
      deriveDotAttrs("hotpink", "prod-db");

    expect(hasExplicitColor).toBe(false);
    expect(dataColor).toBeUndefined();
    // Falls through to env heuristic
    expect(dataEnv).toBe("prod");
  });

  it("all valid palette colors are recognized", () => {
    const colors = ["violet", "blue", "green", "amber", "red", "teal", "pink", "gray"];
    for (const c of colors) {
      expect(isConnectionColor(c)).toBe(true);
      expect(connectionColorVar(c as Parameters<typeof connectionColorVar>[0])).toBe(
        `var(--conn-color-${c})`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Swatch derivation contract (mirrors ConnectionRow.tsx behavior)
// ---------------------------------------------------------------------------

describe("ConnectionRow swatch derivation contract", () => {
  it("colored connection shows a swatch with correct --swatch-color", () => {
    const color = "blue";
    const hasColor = isConnectionColor(color);
    const swatchStyle = hasColor
      ? { "--swatch-color": connectionColorVar(color) }
      : undefined;

    expect(hasColor).toBe(true);
    expect(swatchStyle).toBeDefined();
    expect(swatchStyle!["--swatch-color"]).toBe("var(--conn-color-blue)");
  });

  it("uncolored connection (null): no swatch rendered", () => {
    const color = null;
    const hasColor = isConnectionColor(color);
    expect(hasColor).toBe(false);
    // In ConnectionRow: {isConnectionColor(connection.color) && <span .../>}
    // so no swatch element is created
  });
});
