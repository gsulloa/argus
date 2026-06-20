/**
 * Shared log-rendering helpers for the CloudWatch Insights result panel and the
 * raw event tail. Keeping them here means both views format timestamps and
 * messages identically, so the two feel like one log viewer.
 */

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * Format a log timestamp as a readable local datetime `YYYY-MM-DD HH:mm:ss.SSS`.
 *
 * Accepts:
 *  - epoch milliseconds (number, or all-digit string) — e.g. event `ts`
 *  - a CloudWatch Insights `@timestamp` string (UTC, `YYYY-MM-DD HH:mm:ss.SSS`)
 *  - an ISO-8601 string
 *
 * Returns the original value unchanged when it cannot be parsed as a date.
 */
export function formatLogTs(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";

  let date: Date;
  if (typeof value === "number") {
    date = new Date(value);
  } else if (/^\d+$/.test(value)) {
    // All-digit string → epoch milliseconds.
    date = new Date(Number(value));
  } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(value)) {
    // Insights `@timestamp` is UTC with a space separator; normalize to ISO and
    // mark it as UTC so it isn't misread as local time.
    const iso = value.replace(" ", "T");
    date = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
  } else {
    date = new Date(value);
  }

  if (Number.isNaN(date.getTime())) return String(value);

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${pad(date.getMilliseconds(), 3)}`
  );
}

/**
 * If `text` is valid JSON (object or array), return it pretty-printed with
 * 2-space indentation; otherwise return the original text unchanged.
 */
export function prettyMaybeJson(text: string): { isJson: boolean; text: string } {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return { isJson: false, text };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object") {
      return { isJson: true, text: JSON.stringify(parsed, null, 2) };
    }
  } catch {
    // not JSON — fall through
  }
  return { isJson: false, text };
}

/** Whether `query`'s characters appear in order within `haystack` (a fuzzy
 * subsequence match). Both inputs are compared as-is — callers lowercase first.
 * Modeled on the command palette's `fuzzySubsequenceScore`, reduced to a bool. */
function isSubsequence(haystack: string, query: string): boolean {
  if (!query) return true;
  let hi = 0;
  for (let qi = 0; qi < query.length; qi++) {
    const ch = query[qi];
    let found = false;
    while (hi < haystack.length) {
      if (haystack[hi] === ch) {
        hi++;
        found = true;
        break;
      }
      hi++;
    }
    if (!found) return false;
  }
  return true;
}

/**
 * Case-insensitive substring match — the primary, predictable log filter.
 * Empty query matches everything.
 */
export function matchesLogSubstring(message: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return message.toLowerCase().includes(q);
}

/**
 * Case-insensitive fuzzy (in-order subsequence) match. Used only as a fallback
 * when a substring filter finds nothing — applied per line it is very permissive
 * (most long log lines contain any short query's characters in order), so it
 * must not be the default filter. Empty query matches everything.
 */
export function matchesLogFuzzy(message: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return isSubsequence(message.toLowerCase(), q);
}

/** A run of text plus whether it is part of a filter match (for highlighting). */
export interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * Split `text` into highlight segments for the active filter `query`, mirroring
 * the two-tier matcher: highlight ALL case-insensitive substring occurrences;
 * if there are none, fall back to marking the first in-order subsequence of the
 * query's characters. Original text (and case) is preserved — only `match`
 * flags vary. An empty query yields a single unmatched segment.
 */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const q = query.trim();
  if (!q) return [{ text, match: false }];

  const lower = text.toLowerCase();
  const ql = q.toLowerCase();

  // Substring pass: collect all non-overlapping occurrences.
  const ranges: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const idx = lower.indexOf(ql, from);
    if (idx === -1) break;
    ranges.push([idx, idx + ql.length]);
    from = idx + ql.length;
  }

  // Fuzzy fallback: mark the first in-order run of the query's characters.
  if (ranges.length === 0) {
    let qi = 0;
    for (let i = 0; i < text.length && qi < ql.length; i++) {
      if (lower[i] === ql[qi]) {
        ranges.push([i, i + 1]);
        qi++;
      }
    }
    if (qi < ql.length) return [{ text, match: false }]; // not actually a match
  }

  // Build alternating segments from the (sorted, non-overlapping) ranges.
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
    segments.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}
