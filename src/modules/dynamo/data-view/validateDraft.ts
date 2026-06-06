import type { TableDescription } from "@/modules/dynamo/tables/types";
import { compileModel } from "./modelCompiler";
import type { ModelDraft } from "./types";

export interface AccessPatternIssue {
  /** Index of the offending access pattern in draft.access_patterns. */
  index: number;
  reason: string;
  /** Optional field hint from the compiler (e.g. "index", "pk", "sk"). */
  field?: string;
}

export interface DraftValidation {
  valid: boolean;
  /** Per-access-pattern errors, keyed by array index. */
  issues: AccessPatternIssue[];
  /**
   * True when full schema validation could not run because the
   * TableDescription was unavailable; only template grammar was checked.
   */
  schemaChecksSkipped: boolean;
}

// ---------------------------------------------------------------------------
// Grammar-only template validator (offline / no TableDescription)
//
// Mirrors parseTemplate semantics from modelCompiler.ts:
//   - Unterminated "${" (no closing "}") → error
//   - Ident must match ^[A-Za-z_][A-Za-z0-9_]*$
// ---------------------------------------------------------------------------

function grammarError(template: string): string | null {
  let i = 0;
  while (i < template.length) {
    if (template[i] === "$" && template[i + 1] === "{") {
      const closeIdx = template.indexOf("}", i + 2);
      if (closeIdx === -1) {
        return `Unterminated "\${" in template: ${JSON.stringify(template)}`;
      }
      const ident = template.slice(i + 2, closeIdx);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
        return `Invalid placeholder identifier "${ident}" in template: ${JSON.stringify(template)}`;
      }
      i = closeIdx + 1;
    } else {
      i++;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sentinel-param builder: fills every ${ident} placeholder with "x"
// ---------------------------------------------------------------------------

function sentinelParams(pk: string, sk: string | undefined): Record<string, string> {
  const params: Record<string, string> = {};
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  for (const template of [pk, sk ?? ""]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(template)) !== null) {
      const ident = m[1];
      if (ident !== undefined) {
        params[ident] = "x";
      }
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates a ModelDraft against an optional TableDescription.
 *
 * When `describe` is present: full schema validation via compileModel (index
 * existence, attribute existence, key typing) using sentinel-filled params.
 *
 * When `describe` is absent: grammar-only validation (template syntax only).
 *
 * Returns a DraftValidation with `valid`, `issues`, and `schemaChecksSkipped`.
 */
export function validateDraft(
  draft: ModelDraft,
  describe: TableDescription | null | undefined,
): DraftValidation {
  const issues: AccessPatternIssue[] = [];

  // Name is required
  if (draft.name.trim() === "") {
    issues.push({ index: -1, reason: "Entity name is required" });
    return { valid: false, issues, schemaChecksSkipped: describe == null };
  }

  // At least one access pattern is required
  if (draft.access_patterns.length === 0) {
    issues.push({ index: -1, reason: "Add at least one access pattern" });
    return { valid: false, issues, schemaChecksSkipped: describe == null };
  }

  if (describe) {
    // Full schema validation — sentinel-fill all params and run through compileModel
    for (let i = 0; i < draft.access_patterns.length; i++) {
      const ap = draft.access_patterns[i];
      if (!ap) continue;
      const params = sentinelParams(ap.pk, ap.sk);
      const result = compileModel(ap, params, describe);
      if (result.kind === "error") {
        issues.push({ index: i, reason: result.reason, field: result.field });
      }
    }
    return { valid: issues.length === 0, issues, schemaChecksSkipped: false };
  } else {
    // Grammar-only validation — check template syntax for pk and sk
    for (let i = 0; i < draft.access_patterns.length; i++) {
      const ap = draft.access_patterns[i];
      if (!ap) continue;

      const pkErr = grammarError(ap.pk);
      if (pkErr !== null) {
        issues.push({ index: i, reason: pkErr, field: "pk" });
      }

      if (ap.sk !== undefined) {
        const skErr = grammarError(ap.sk);
        if (skErr !== null) {
          issues.push({ index: i, reason: skErr, field: "sk" });
        }
      }
    }
    return { valid: issues.length === 0, issues, schemaChecksSkipped: true };
  }
}
