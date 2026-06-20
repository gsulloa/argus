## Context

`EventsTab` renders each message as `prettyMaybeJson(ev.message).text` and filters via the two-tier matcher in `logFormat.ts` (`matchesLogSubstring` first, `matchesLogFuzzy` fallback). The filtered list is shown but the match itself isn't marked. `DESIGN.md` reserves `--accent` / `--accent-soft` for "palette match", so accent-highlighting a search hit is on-brand.

## Key decisions

### 1. A segmenter that mirrors the two-tier matcher

Add `highlightSegments(text, query): Array<{ text: string; match: boolean }>` to `logFormat.ts`:

```
q = query.trim()
if !q → [{ text, match:false }]

substring pass (case-insensitive): find ALL non-overlapping occurrences of q in text;
   if ≥1 → return alternating non-match / match segments covering the whole string
else (no substring) → subsequence pass: walk text, mark the first in-order run of chars
   that spells q (case-insensitive); each marked char (or contiguous run) is a match segment
```

This mirrors the filter's substring-first / fuzzy-fallback logic, so what gets highlighted is exactly *why* the line survived the filter. Segmentation preserves the original text (including case and JSON whitespace) — only `match` flags differ.

### 2. Render segments, not plain text

In the message `<td>`, when a query is active render `highlightSegments(displayText, query).map(seg => seg.match ? <mark> : text)`. The displayed text is the same `prettyMaybeJson(ev.message).text` already shown, so highlights line up with JSON pretty-printing and wrapping. When no query is active, render the plain string (no segmenter cost).

### 3. Styling (DESIGN.md)

The match span uses `background: var(--accent-soft)`, `color: var(--accent-hover)` (or `--text` for contrast), `border-radius: var(--radius-sm)`, inheriting the mono font — subtle, single-accent, no yellow, no bold-everything. Implemented as a `<mark>` with inline style or a CSS-module class; reset the browser's default `<mark>` yellow.

## Risks / trade-offs

- **Many occurrences in long JSON**: highlighting every occurrence is fine; segments are computed only for rendered (filtered) rows, lazily per render. Row counts are bounded by the loaded page.
- **Subsequence highlight density**: in the fuzzy fallback, scattered single-char highlights can look noisy — acceptable because the fallback only triggers when no substring matched (a rare, intentional case), and it still shows the user which chars hit.
- **Overlap**: substring occurrences are matched non-overlapping left-to-right, which is the intuitive behavior for find-style highlighting.

## Migration

None. Purely presentational; backend, filtering, persistence, and shapes unchanged.
