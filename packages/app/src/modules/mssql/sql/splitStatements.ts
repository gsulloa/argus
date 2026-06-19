/**
 * T-SQL (MS SQL Server) statement splitter.
 *
 * Two-level split per design D10:
 * 1. Batch level: split on `GO` (case-insensitive, line-leading, optional integer
 *    repeat count). GO is a client directive - never sent to the server.
 * 2. Statement level (within a batch): split on `;` honoring:
 *    - Single-quoted strings `'...'` with `''` escape
 *    - Double-quoted identifiers `"..."` with `""` escape
 *    - Square-bracket identifiers `[...]` with `]]` escape (may contain `;`)
 *    - `--` line comments (no trailing-space requirement)
 *    - block comments (slash-star ... star-slash) with nesting support
 *    - `#` is NOT a comment delimiter in T-SQL
 *
 * Multi-statement runs validate that CREATE PROCEDURE / FUNCTION / TRIGGER / VIEW
 * does not appear after the first `;` in a batch (must be the first statement).
 */

export interface Statement {
  /** Trimmed SQL text (without the trailing `;`). */
  sql: string;
  /** Start offset (inclusive) of the trimmed SQL inside the source document. */
  startOffset: number;
  /** End offset (exclusive) of the trimmed SQL inside the source document. */
  endOffset: number;
}

type LexState =
  | { kind: "normal" }
  | { kind: "single" }            // '...'
  | { kind: "double" }            // "..."
  | { kind: "bracket" }           // [...]
  | { kind: "lineComment" }       // --
  | { kind: "blockComment"; depth: number }; // /* ... */ nested

// ---------------------------------------------------------------------------
// Batch-level split on GO
// ---------------------------------------------------------------------------

interface Batch {
  sql: string;
  /** Start offset of this batch inside the original source. */
  baseOffset: number;
  /** How many times to repeat the batch (GO N). */
  repeat: number;
}

/**
 * GO regex: must be the only token on its line (besides optional trailing count).
 * Captures the optional repeat integer in group 1.
 */
const GO_RE = /^[ \t]*(go)(?:[ \t]+(\d+))?[ \t]*(?:--[^\n]*)?$/im;

function splitBatches(source: string): Batch[] {
  const batches: Batch[] = [];
  let rest = source;
  let absolutePos = 0;

  while (rest.length > 0) {
    const m = GO_RE.exec(rest);
    if (!m || m.index === undefined) {
      // No more GO - remaining text is the last batch.
      batches.push({ sql: rest, baseOffset: absolutePos, repeat: 1 });
      break;
    }

    // Text before the GO line.
    const batchText = rest.slice(0, m.index);
    const repeat = m[2] ? Math.max(1, parseInt(m[2], 10)) : 1;

    if (batchText.trim().length > 0) {
      batches.push({ sql: batchText, baseOffset: absolutePos, repeat });
    }

    // Advance past the GO line (including the newline after it, if any).
    const goLineEnd = m.index + m[0].length;
    const advance = goLineEnd + (rest[goLineEnd] === "\n" ? 1 : 0);
    absolutePos += advance;
    rest = rest.slice(advance);
  }
  return batches;
}

// ---------------------------------------------------------------------------
// Statement-level split on `;` within a batch
// ---------------------------------------------------------------------------

function splitBatchStatements(batchSql: string, baseOffset: number): Statement[] {
  const out: Statement[] = [];
  let state: LexState = { kind: "normal" };
  let segmentStart = 0;
  let i = 0;

  function flushSegment(endExclusive: number) {
    const raw = batchSql.slice(segmentStart, endExclusive);
    let s = 0;
    while (s < raw.length && /\s/.test(raw[s]!)) s += 1;
    let e = raw.length;
    while (e > s && /\s/.test(raw[e - 1]!)) e -= 1;
    if (e <= s) return;
    out.push({
      sql: raw.slice(s, e),
      startOffset: baseOffset + segmentStart + s,
      endOffset: baseOffset + segmentStart + e,
    });
  }

  while (i < batchSql.length) {
    const c = batchSql[i]!;
    switch (state.kind) {
      case "normal": {
        if (c === ";") {
          flushSegment(i);
          segmentStart = i + 1;
          i += 1;
          break;
        }
        if (c === "'") { state = { kind: "single" }; i += 1; break; }
        if (c === '"') { state = { kind: "double" }; i += 1; break; }
        if (c === "[") { state = { kind: "bracket" }; i += 1; break; }
        if (c === "-" && batchSql[i + 1] === "-") { state = { kind: "lineComment" }; i += 2; break; }
        if (c === "/" && batchSql[i + 1] === "*") { state = { kind: "blockComment", depth: 1 }; i += 2; break; }
        i += 1;
        break;
      }
      case "single": {
        // '' is the escape for a single quote inside a string
        if (c === "'" && batchSql[i + 1] === "'") { i += 2; break; }
        if (c === "'") { state = { kind: "normal" }; i += 1; break; }
        i += 1;
        break;
      }
      case "double": {
        if (c === '"' && batchSql[i + 1] === '"') { i += 2; break; }
        if (c === '"') { state = { kind: "normal" }; i += 1; break; }
        i += 1;
        break;
      }
      case "bracket": {
        // ]] is the escape for ] inside a bracket identifier
        if (c === "]" && batchSql[i + 1] === "]") { i += 2; break; }
        if (c === "]") { state = { kind: "normal" }; i += 1; break; }
        i += 1;
        break;
      }
      case "lineComment": {
        if (c === "\n") { state = { kind: "normal" }; }
        i += 1;
        break;
      }
      case "blockComment": {
        if (c === "/" && batchSql[i + 1] === "*") {
          state = { kind: "blockComment", depth: state.depth + 1 };
          i += 2;
          break;
        }
        if (c === "*" && batchSql[i + 1] === "/") {
          const nextDepth: number = state.depth - 1;
          state = nextDepth > 0 ? { kind: "blockComment", depth: nextDepth } : { kind: "normal" };
          i += 2;
          break;
        }
        i += 1;
        break;
      }
    }
  }

  flushSegment(batchSql.length);
  return out;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** First keyword of a statement (uppercase). */
function firstKeyword(sql: string): string {
  const m = sql.trimStart().match(/^([A-Za-z_]\w*)/);
  return m ? m[1]!.toUpperCase() : "";
}

/** Two-word prefix (e.g. "CREATE PROCEDURE"). */
function twoWordPrefix(sql: string): string {
  const m = sql.trimStart().match(/^([A-Za-z_]\w*)(?:\s+([A-Za-z_]\w*))?/);
  if (!m) return "";
  const w1 = (m[1] ?? "").toUpperCase();
  const w2 = (m[2] ?? "").toUpperCase();
  return w2 ? `${w1} ${w2}` : w1;
}

const BATCH_FIRST_REQUIRED = new Set([
  "CREATE PROCEDURE",
  "CREATE FUNCTION",
  "CREATE TRIGGER",
  "CREATE VIEW",
]);

/**
 * Validate a batch of statements for multi-statement run.
 * Rejects if CREATE PROCEDURE / FUNCTION / TRIGGER / VIEW appears after the
 * first statement in a batch (they must be first in their batch).
 * Returns null on success, or an error message string.
 */
export function validateBatch(stmts: Statement[]): string | null {
  for (let i = 1; i < stmts.length; i++) {
    const sql = stmts[i]!.sql;
    const prefix = twoWordPrefix(sql);
    if (BATCH_FIRST_REQUIRED.has(prefix)) {
      return `${prefix} must be the first statement in its batch; insert a 'GO' separator before it.`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Split a T-SQL document into a flat list of statements, expanding GO N
 * repeats and stripping GO lines.
 */
export function splitStatements(source: string): Statement[] {
  const batches = splitBatches(source);
  const allStatements: Statement[] = [];

  for (const batch of batches) {
    const stmts = splitBatchStatements(batch.sql, batch.baseOffset);
    // Repeat the batch N times (GO N support).
    for (let r = 0; r < batch.repeat; r++) {
      for (const stmt of stmts) {
        allStatements.push(stmt);
      }
    }
  }

  return allStatements;
}

/**
 * Pick the statement (or batch) under the cursor offset.
 * When the cursor is in whitespace/comment between statements,
 * returns the immediately preceding statement.
 * Returns null only if the document has no non-empty statements.
 */
export function getStatementUnderCursor(
  source: string,
  cursorOffset: number,
): Statement | null {
  const stmts = splitStatements(source);
  if (stmts.length === 0) return null;
  for (let idx = 0; idx < stmts.length; idx++) {
    const s = stmts[idx]!;
    const next = stmts[idx + 1];
    const gapEnd = next ? next.startOffset : source.length;
    if (cursorOffset >= s.startOffset && cursorOffset <= gapEnd) {
      return s;
    }
  }
  return stmts[0]!;
}

/**
 * First keyword of a statement (for display purposes).
 * Exported for use in useQueryRun.ts.
 */
export { firstKeyword };
