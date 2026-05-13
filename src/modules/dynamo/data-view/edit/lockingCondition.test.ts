/**
 * lockingCondition.test.ts — task 10.6
 *
 * Unit tests for buildLockingCondition and mergeConditionExpression.
 */

import { describe, it, expect } from "vitest";
import { buildLockingCondition, mergeConditionExpression } from "./lockingCondition";
import type { AttributeValue } from "../types";

const prevVersion: AttributeValue = { N: "42" };

describe("buildLockingCondition — inactive cases", () => {
  it("returns null when versionAttr is empty", () => {
    expect(buildLockingCondition("", prevVersion, "pk")).toBeNull();
  });

  it("returns null when prevValue is undefined", () => {
    expect(buildLockingCondition("version", undefined, "pk")).toBeNull();
  });
});

describe("buildLockingCondition — active case", () => {
  it("returns correct condition_expression, names and values", () => {
    const result = buildLockingCondition("version", prevVersion, "pk");
    expect(result).not.toBeNull();
    expect(result!.condition_expression).toBe(
      "attribute_exists(#pk0) AND #v0 = :lock0",
    );
    expect(result!.expression_attribute_names["#pk0"]).toBe("pk");
    expect(result!.expression_attribute_names["#v0"]).toBe("version");
    expect(result!.expression_attribute_values[":lock0"]).toEqual(prevVersion);
  });
});

describe("buildLockingCondition — placeholder collision avoidance", () => {
  it("caller already has #pk0 → allocates #pk1", () => {
    const callerNames = { "#pk0": "existingPk" };
    const result = buildLockingCondition("version", prevVersion, "pk", callerNames);
    expect(result).not.toBeNull();
    // #pk0 is taken, so should use #pk1
    expect(result!.expression_attribute_names["#pk1"]).toBe("pk");
    // #v0 should still be fine (no collision)
    expect(result!.expression_attribute_names["#v0"]).toBe("version");
    // caller names should be preserved
    expect(result!.expression_attribute_names["#pk0"]).toBe("existingPk");
    expect(result!.condition_expression).toBe(
      "attribute_exists(#pk1) AND #v0 = :lock0",
    );
  });

  it("caller already has :lock0 → allocates :lock1", () => {
    const callerValues = { ":lock0": { S: "other" } as AttributeValue };
    const result = buildLockingCondition("version", prevVersion, "pk", null, callerValues);
    expect(result).not.toBeNull();
    expect(result!.expression_attribute_values[":lock1"]).toEqual(prevVersion);
    expect(result!.expression_attribute_values[":lock0"]).toEqual({ S: "other" });
    expect(result!.condition_expression).toContain(":lock1");
  });

  it("merges caller names and values into result", () => {
    const callerNames = { "#status0": "status" };
    const callerValues = { ":val0": { S: "active" } as AttributeValue };
    const result = buildLockingCondition("version", prevVersion, "pk", callerNames, callerValues);
    expect(result).not.toBeNull();
    // Caller entries preserved
    expect(result!.expression_attribute_names["#status0"]).toBe("status");
    expect(result!.expression_attribute_values[":val0"]).toEqual({ S: "active" });
  });
});

describe("mergeConditionExpression", () => {
  it("returns addition when existing is null", () => {
    expect(mergeConditionExpression(null, "attribute_exists(#pk0)")).toBe(
      "attribute_exists(#pk0)",
    );
  });

  it("returns addition when existing is empty string", () => {
    expect(mergeConditionExpression("", "attribute_exists(#pk0)")).toBe(
      "attribute_exists(#pk0)",
    );
  });

  it("joins with AND when existing is non-empty", () => {
    expect(
      mergeConditionExpression("attribute_not_exists(#pk)", "attribute_exists(#pk0) AND #v0 = :lock0"),
    ).toBe("attribute_not_exists(#pk) AND attribute_exists(#pk0) AND #v0 = :lock0");
  });
});
