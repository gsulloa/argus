## Context

`cloudwatch_run_insights` (`insights.rs`) does `limit.unwrap_or(1000).clamp(1, 10_000)` and always calls `.limit(limit)` on `StartQuery`. The `ResultPanel`/`EventsTab` render values as single-line ellipsis cells (`maxWidth: 320`, `whiteSpace: nowrap`). DESIGN.md: compact density (4px base, table cell `5px 12px`), hairline borders only, `--font-mono` for data, single violet accent, radius `--radius-md` 5px, motion `--duration-instant` 80ms hover, no decorative gradients/thick borders.

## Key decisions

### 1. Honor the query's `limit` command

CloudWatch's `StartQuery` has a `limit` **parameter** and the query language has a `| limit N` **command**. Observed: with both present, the parameter (1000) wins over the command (100). So forcing a default param defeats user intent.

Decision: detect whether the query string contains a `limit` command and only pass the param when it does **not**:

```
has_limit_command(query) := regex /(^|\|)\s*limit\s+\d+/i  over the query
StartQuery.limit:
   query has `| limit N`  → DO NOT set the param (query governs → returns N)
   query has no limit      → set param = default (e.g. 1000), still ≤ RESULT_ROW_CAP
```

`RESULT_ROW_CAP` (10_000) remains the hard client-side cap with the `truncated` flag, so a limitless query can never blow up the UI. This is a minimal, well-scoped regex over the query text — not a full parser — and errs safe: if detection misses, behavior is today's (param set), never worse.

### 2. Log-readable rendering (DESIGN.md-grounded)

The result/event view stays a table (columns are dynamic and users sort/copy/export), but each row becomes log-readable:

```
┌ @timestamp (mono, fixed ~180px) ┬ @message (truncated preview) ┬ …fields ┐
│ 2026-06-20 14:03:11.482          │ {"level":"error","msg":"…    │ …       │  ← click row
├─────────────────────────────────┴──────────────────────────────┴─────────┤
│  ▾ detail (full message, wrapped/selectable; JSON pretty-printed)          │  ← expanded
└────────────────────────────────────────────────────────────────────────────┘
```

- **Timestamp**: helper `formatLogTs(value)` → `YYYY-MM-DD HH:mm:ss.SSS` local. Insights returns `@timestamp` as a string already; events provide epoch-ms. Render in `--font-mono`, `--text-muted`, fixed column so rows align.
- **Expandable row**: clicking a row toggles an inline detail row spanning all columns showing the full message. JSON values are detected (`JSON.parse` guard) and pretty-printed (2-space) in a `<pre>` with `white-space: pre-wrap`; non-JSON shown wrapped and selectable. Re-uses cell-copy. One row expanded at a time (or multi — implementer's call, keep simple: single).
- **Density/affordance**: keep compact `5px 12px` cells, hairline `--border` separators, sticky header, hover row highlight at `--duration-instant`, active-cell ring using the existing `--accent` token. No new colors.
- **States**: running → subtle inline indicator consistent with the app (no spinner zoo); empty → quiet italic; error → existing alert style (hairline, `--radius-md`).
- **EventsTab parity**: same `formatLogTs` + same expandable/JSON-pretty message treatment so the raw tail and Insights feel like one log viewer.

Apply the `/frontend-design` lens during implementation: match DESIGN.md exactly, flag/avoid anti-patterns (gradients, thick borders, bubbly radii, multiple accents).

### 3. No backend command/shape changes

The result envelope is unchanged; rendering is purely frontend. The only backend change is the conditional `limit` param.

## Risks / trade-offs

- **Regex limit detection**: a `limit` inside a string literal or comment could be misdetected. Acceptable — worst case we skip setting the param and the query's (real or absent) limit + the 10k client cap still bound results. Documented; a query parser is overkill here.
- **JSON pretty-print cost**: only the expanded row is parsed/formatted (lazy), so large result sets aren't eagerly parsed.
- **Single-expand vs multi**: single keeps state trivial and the panel height predictable.

## Migration

None. Frontend rendering + one conditional backend param; envelope, persistence, and events unchanged.
