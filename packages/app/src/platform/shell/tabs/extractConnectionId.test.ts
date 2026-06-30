import { describe, expect, it } from "vitest";
import { extractConnectionId } from "./TabsContext";

// Minimal helper matching the shape extractConnectionId expects.
// OpenInput is not exported from TabsContext, so we construct plain objects.
function makeInput(payload: unknown): Parameters<typeof extractConnectionId>[0] {
  return { kind: "test", title: "Test", payload } as never;
}

describe("extractConnectionId", () => {
  it("resolves initialConnectionId for postgres-query payloads", () => {
    const input = makeInput({ initialConnectionId: "conn-prod", initialSql: "" });
    expect(extractConnectionId(input)).toBe("conn-prod");
  });

  it("resolves connectionId for MySQL/MSSQL-style payloads", () => {
    const input = makeInput({ connectionId: "conn-a" });
    expect(extractConnectionId(input)).toBe("conn-a");
  });

  it("prefers connectionId over initialConnectionId when both are present", () => {
    const input = makeInput({
      connectionId: "conn-a",
      initialConnectionId: "conn-b",
    });
    expect(extractConnectionId(input)).toBe("conn-a");
  });

  it("returns null when neither field is present", () => {
    expect(extractConnectionId(makeInput({ initialSql: "" }))).toBeNull();
  });

  it("returns null for a null payload", () => {
    expect(extractConnectionId(makeInput(null))).toBeNull();
  });

  it("returns null for a non-string connectionId", () => {
    expect(extractConnectionId(makeInput({ connectionId: 123 }))).toBeNull();
  });

  it("returns null for a non-string initialConnectionId", () => {
    expect(
      extractConnectionId(makeInput({ initialConnectionId: true })),
    ).toBeNull();
  });
});
