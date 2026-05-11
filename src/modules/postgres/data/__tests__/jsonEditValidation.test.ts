import { describe, expect, it } from "vitest";
import { hasSmartQuotes, validateJsonInput } from "../jsonEditValidation";

describe("validateJsonInput", () => {
  it("accepts a valid object and returns canonical form", () => {
    const result = validateJsonInput('{ "foo": "bar" }');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canonical).toBe(JSON.stringify(JSON.parse('{ "foo": "bar" }')));
    }
  });

  it("accepts a valid array", () => {
    const result = validateJsonInput('[1, 2, 3]');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canonical).toBe("[1,2,3]");
    }
  });

  it("accepts a valid string scalar", () => {
    const result = validateJsonInput('"hello"');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canonical).toBe('"hello"');
    }
  });

  it("accepts a valid number scalar", () => {
    const result = validateJsonInput('42');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canonical).toBe("42");
    }
  });

  it("accepts a valid boolean scalar", () => {
    const result = validateJsonInput('true');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canonical).toBe("true");
    }
  });

  it("accepts JSON null literal", () => {
    const result = validateJsonInput('null');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canonical).toBe("null");
    }
  });

  it("returns empty canonical for empty string (null write)", () => {
    const result = validateJsonInput('');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canonical).toBe("");
    }
  });

  it("returns empty canonical for whitespace-only string (null write)", () => {
    const result = validateJsonInput('   \n  ');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canonical).toBe("");
    }
  });

  it("rejects JSON with missing closing brace", () => {
    const result = validateJsonInput('{ "foo": "bar"');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("rejects smart-quoted outer delimiters (not valid JSON)", () => {
    const result = validateJsonInput('“foo”');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("rejects pasted HTML", () => {
    const result = validateJsonInput('<div>hello</div>');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("accepts JSON with smart quotes inside string content", () => {
    const input = '{"k":"a“b”c"}';
    const result = validateJsonInput(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canonical).toContain("“");
      expect(result.canonical).toContain("”");
    }
  });
});

describe("hasSmartQuotes", () => {
  it("returns true when canonical contains U+201C", () => {
    expect(hasSmartQuotes('{"name":"John “Doe” Smith"}')).toBe(true);
  });

  it("returns true when canonical contains U+201D", () => {
    expect(hasSmartQuotes("ends with ”")).toBe(true);
  });

  it("returns true when canonical contains U+2018", () => {
    expect(hasSmartQuotes("it‘s")).toBe(true);
  });

  it("returns true when canonical contains U+2019", () => {
    expect(hasSmartQuotes("it’s")).toBe(true);
  });

  it("returns false for ASCII-only JSON", () => {
    expect(hasSmartQuotes('{"foo":"bar"}')).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(hasSmartQuotes("")).toBe(false);
  });
});
