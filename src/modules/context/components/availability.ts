/**
 * Shared error-classification helper for context folder availability.
 *
 * Returns true when the given error message indicates the context folder
 * is missing or has an unreadable manifest (i.e. "Unavailable" state).
 * Returns false for other errors (e.g. permission errors, unexpected backend
 * failures) where the folder may still be present.
 *
 * Used by both ContextFolderRow and ContextFolderBanner so both surfaces
 * agree on what counts as "unavailable".
 */
export function isMissingFolderError(message: string): boolean {
  const lc = message.toLowerCase();
  return (
    lc.includes("not found") ||
    lc.includes("missingmanifest") ||
    lc.includes("missing_manifest") ||
    lc.includes("unsupportedmanifestversion") ||
    lc.includes("unsupported_manifest_version")
  );
}
