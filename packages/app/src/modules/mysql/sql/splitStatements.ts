/**
 * MySQL-aware SQL statement splitter. Walks source character-by-character with
 * an explicit state machine so that semicolons inside strings, block comments,
 * and backtick-quoted identifiers do not split.
 *
 * MySQL-specific adaptations vs. the Postgres version:
 * - Recognises `# …` line comments in addition to `-- ` and block comments.
 * - Backtick-quoted identifiers may contain semicolons; the splitter does NOT
 *   split inside backtick regions.
 * - Dollar-quoted bodies (Postgres extension) are NOT supported — not valid MySQL.
 * - Detects DELIMITER-block-like first keywords and rejects them per design D10.
 */

export interface Statement {
  /** Trimmed SQL text (without the trailing `;`). */
  sql: string;
  /** Start offset (inclusive) of the trimmed SQL inside the source document. */
  startOffset: number;
  /** End offset (exclusive) of the trimmed SQL inside the source document. */
  endOffset: number;
}

type State =
  | { kind: "normal" }
  | { kind: "single" }    // '...'
  | { kind: "double" }    // "..."
  | { kind: "backtick" }  // `...`
  | { kind: "lineComment" }
  | { kind: "blockComment"; depth: number };

/** First keyword of a statement extracted by scanning for the first word. */
function firstKeyword(sql: string): string {
  const m = sql.trimStart().match(/^([A-Za-z_]\w*)/);
  return m ? m[1]!.toUpperCase() : "";
}

/** Keywords that indicate a DDL routine body — reject for multi-statement runs. */
const DELIMITER_REJECTIONS = new Set([
  "CREATE PROCEDURE",
  "CREATE FUNCTION",
  "CREATE TRIGGER",
  "CREATE EVENT",
]);

function startsWithRejected(sql: string): boolean {
  const trimmed = sql.trimStart();
  for (const prefix of DELIMITER_REJECTIONS) {
    if (trimmed.toUpperCase().startsWith(prefix)) return true;
  }
  return false;
}

export function splitStatements(sql: string): Statement[] {
  const out: Statement[] = [];
  let state: State = { kind: "normal" };
  let segmentStart = 0;
  let i = 0;

  function flushSegment(endExclusive: number) {
    const raw = sql.slice(segmentStart, endExclusive);
    let s = 0;
    while (s < raw.length && /\s/.test(raw[s]!)) s += 1;
    let e = raw.length;
    while (e > s && /\s/.test(raw[e - 1]!)) e -= 1;
    if (e <= s) return;
    out.push({
      sql: raw.slice(s, e),
      startOffset: segmentStart + s,
      endOffset: segmentStart + e,
    });
  }

  while (i < sql.length) {
    const c = sql[i]!;
    switch (state.kind) {
      case "normal": {
        if (c === ";") {
          flushSegment(i);
          segmentStart = i + 1;
          i += 1;
          break;
        }
        if (c === "'") {
          state = { kind: "single" };
          i += 1;
          break;
        }
        if (c === '"') {
          state = { kind: "double" };
          i += 1;
          break;
        }
        if (c === "`") {
          state = { kind: "backtick" };
          i += 1;
          break;
        }
        if (c === "#") {
          // MySQL line comment
          state = { kind: "lineComment" };
          i += 1;
          break;
        }
        if (c === "-" && sql[i + 1] === "-") {
          state = { kind: "lineComment" };
          i += 2;
          break;
        }
        if (c === "/" && sql[i + 1] === "*") {
          state = { kind: "blockComment", depth: 1 };
          i += 2;
          break;
        }
        i += 1;
        break;
      }
      case "single": {
        if (c === "'" && sql[i + 1] === "'") {
          i += 2;
          break;
        }
        if (c === "'") {
          state = { kind: "normal" };
          i += 1;
          break;
        }
        i += 1;
        break;
      }
      case "double": {
        if (c === '"' && sql[i + 1] === '"') {
          i += 2;
          break;
        }
        if (c === '"') {
          state = { kind: "normal" };
          i += 1;
          break;
        }
        i += 1;
        break;
      }
      case "backtick": {
        if (c === "`" && sql[i + 1] === "`") {
          // Escaped backtick inside identifier.
          i += 2;
          break;
        }
        if (c === "`") {
          state = { kind: "normal" };
          i += 1;
          break;
        }
        i += 1;
        break;
      }
      case "lineComment": {
        if (c === "\n") {
          state = { kind: "normal" };
        }
        i += 1;
        break;
      }
      case "blockComment": {
        if (c === "/" && sql[i + 1] === "*") {
          state = { kind: "blockComment", depth: state.depth + 1 };
          i += 2;
          break;
        }
        if (c === "*" && sql[i + 1] === "/") {
          const nextDepth: number = state.depth - 1;
          state =
            nextDepth > 0
              ? { kind: "blockComment", depth: nextDepth }
              : { kind: "normal" };
          i += 2;
          break;
        }
        i += 1;
        break;
      }
    }
  }

  flushSegment(sql.length);
  return out;
}

/**
 * Validate a batch of statements for multi-statement run.
 * Rejects if any statement begins with CREATE PROCEDURE / FUNCTION / TRIGGER / EVENT.
 * Returns null on success, or an error message string.
 */
export function validateBatch(stmts: Statement[]): string | null {
  for (const s of stmts) {
    if (startsWithRejected(s.sql)) {
      const kw = firstKeyword(s.sql);
      return `${kw} bodies contain DELIMITER blocks that are not supported in multi-statement runs — run as a single statement.`;
    }
  }
  return null;
}

/**
 * Pick the statement that contains `cursorOffset`. When the cursor is in
 * whitespace/comment between two statements, returns the immediately
 * preceding statement. Returns `null` only if the document has no
 * non-empty statements.
 */
export function getStatementUnderCursor(
  sql: string,
  cursorOffset: number,
): Statement | null {
  const stmts = splitStatements(sql);
  if (stmts.length === 0) return null;
  for (let idx = 0; idx < stmts.length; idx += 1) {
    const s = stmts[idx]!;
    const next = stmts[idx + 1];
    const gapEnd = next ? next.startOffset : sql.length;
    if (cursorOffset >= s.startOffset && cursorOffset <= gapEnd) {
      return s;
    }
  }
  return stmts[0]!;
}
