/**
 * SQL-aware statement splitter. Walks the source character-by-character with
 * an explicit state machine so that semicolons inside strings, dollar-quoted
 * bodies, and comments do not split.
 *
 * The output drops the trailing `;` of each statement and trims surrounding
 * whitespace, but the `startOffset` / `endOffset` remain anchored to the
 * original source so the editor can move the cursor accurately on errors.
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
  | { kind: "single" }
  | { kind: "double" }
  | { kind: "dollar"; tag: string }
  | { kind: "lineComment" }
  | { kind: "blockComment"; depth: number };

/**
 * Tries to read a Postgres dollar-quote tag starting at `i`. Returns the tag
 * (which may be empty for `$$`) and the offset just past the closing `$`,
 * or null if the position isn't a valid dollar-quote opener.
 */
function readDollarTag(src: string, i: number): { tag: string; next: number } | null {
  if (src[i] !== "$") return null;
  let j = i + 1;
  while (j < src.length) {
    const c = src[j]!;
    if (c === "$") {
      return { tag: src.slice(i + 1, j), next: j + 1 };
    }
    // Tag may contain letters, digits, underscores. Anything else aborts.
    if (!(/[A-Za-z0-9_]/.test(c))) {
      return null;
    }
    j += 1;
  }
  return null;
}

export function splitStatements(sql: string): Statement[] {
  const out: Statement[] = [];
  let state: State = { kind: "normal" };
  let segmentStart = 0;
  let i = 0;

  function flushSegment(endExclusive: number) {
    const raw = sql.slice(segmentStart, endExclusive);
    // Trim leading whitespace.
    let s = 0;
    while (s < raw.length && /\s/.test(raw[s]!)) s += 1;
    // Trim trailing whitespace.
    let e = raw.length;
    while (e > s && /\s/.test(raw[e - 1]!)) e -= 1;
    if (e <= s) return; // empty segment
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
        if (c === "$") {
          const tag = readDollarTag(sql, i);
          if (tag) {
            state = { kind: "dollar", tag: tag.tag };
            i = tag.next;
            break;
          }
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
          // Escape: '' inside string.
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
      case "dollar": {
        if (c === "$") {
          // Look for matching close `$tag$`.
          const close = `$${state.tag}$`;
          if (sql.slice(i, i + close.length) === close) {
            state = { kind: "normal" };
            i += close.length;
            break;
          }
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

  // Flush the trailing segment (no semicolon).
  flushSegment(sql.length);
  return out;
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
  // Find a statement whose [startOffset, endOffset] (inclusive of trailing
  // whitespace up to next stmt) covers the cursor. We use the actual range
  // and the gap until the next statement's start.
  for (let i = 0; i < stmts.length; i += 1) {
    const s = stmts[i]!;
    const next = stmts[i + 1];
    const gapEnd = next ? next.startOffset : sql.length;
    if (cursorOffset >= s.startOffset && cursorOffset <= gapEnd) {
      return s;
    }
  }
  // Cursor is before the first statement (e.g. in a leading comment).
  // Return the first one — running it is the user's most likely intent.
  return stmts[0]!;
}
