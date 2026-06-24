import { describe, expect, it } from "vitest";
import { splitValues } from "./ValueInput";

describe("splitValues", () => {
  // ------------------------------------------------------------------
  // Numeric category — splits on commas, newlines, AND whitespace runs
  // ------------------------------------------------------------------

  it("numeric: splits a comma-separated list", () => {
    expect(splitValues("31001, 31002, 31003", "numeric")).toEqual(["31001", "31002", "31003"]);
  });

  it("numeric: splits on whitespace runs", () => {
    expect(splitValues("31001 31002 31003", "numeric")).toEqual(["31001", "31002", "31003"]);
  });

  it("numeric: splits mixed comma+whitespace", () => {
    expect(splitValues("31001 31002,31003", "numeric")).toEqual(["31001", "31002", "31003"]);
  });

  it("numeric: splits newline-separated values", () => {
    expect(splitValues("31001\n31002\n31003", "numeric")).toEqual(["31001", "31002", "31003"]);
  });

  it("numeric: drops empty fragments between consecutive delimiters", () => {
    expect(splitValues("31001,,31002", "numeric")).toEqual(["31001", "31002"]);
  });

  it("numeric: single value returns one-element array", () => {
    expect(splitValues("31001", "numeric")).toEqual(["31001"]);
  });

  it("numeric: empty string returns empty array", () => {
    expect(splitValues("", "numeric")).toEqual([]);
  });

  it("numeric: trims surrounding whitespace from each fragment", () => {
    expect(splitValues("  31001  ,  31002  ", "numeric")).toEqual(["31001", "31002"]);
  });

  // ------------------------------------------------------------------
  // Text category — splits on commas and newlines only, NOT whitespace
  // ------------------------------------------------------------------

  it("text: does NOT split on whitespace (multi-word values preserved)", () => {
    expect(splitValues("New York", "text")).toEqual(["New York"]);
  });

  it("text: splits on comma", () => {
    expect(splitValues("foo,bar", "text")).toEqual(["foo", "bar"]);
  });

  it("text: splits on newline", () => {
    expect(splitValues("foo\nbar", "text")).toEqual(["foo", "bar"]);
  });

  it("text: does not split space-separated single value", () => {
    expect(splitValues("hello world", "text")).toEqual(["hello world"]);
  });

  it("text: drops empty fragments", () => {
    expect(splitValues("foo,,bar", "text")).toEqual(["foo", "bar"]);
  });

  it("text: single value returns one-element array", () => {
    expect(splitValues("hello", "text")).toEqual(["hello"]);
  });
});
