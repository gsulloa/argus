import { describe, expect, it } from "vitest";
import { isMissingFolderError } from "../availability";

describe("isMissingFolderError", () => {
  it("returns true for 'not found' message", () => {
    expect(isMissingFolderError("Context folder not found")).toBe(true);
    expect(isMissingFolderError("Not Found")).toBe(true);
  });

  it("returns true for MissingManifest error messages", () => {
    expect(isMissingFolderError("MissingManifest: context.yaml not found")).toBe(true);
    expect(isMissingFolderError("missing_manifest error")).toBe(true);
  });

  it("returns true for UnsupportedManifestVersion error messages", () => {
    expect(isMissingFolderError("UnsupportedManifestVersion: 99")).toBe(true);
    expect(isMissingFolderError("unsupported_manifest_version 99 found")).toBe(true);
  });

  it("returns false for unrelated error messages", () => {
    expect(isMissingFolderError("Permission denied")).toBe(false);
    expect(isMissingFolderError("Internal server error")).toBe(false);
    expect(isMissingFolderError("Connection refused")).toBe(false);
    expect(isMissingFolderError("")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isMissingFolderError("NOT FOUND")).toBe(true);
    expect(isMissingFolderError("MISSINGMANIFEST")).toBe(true);
  });
});
