## Context

`EventsTab` (`src/modules/cloudwatch/events/EventsTab.tsx`) renders the loaded `events: LogEventItem[]` in a timestamp+message table and pages with "load older / newer". `EventsTabRoot({ tab, active })` already receives `active` (unused today). The app has two reusable precedents: the ⌘F-gated-on-`active` keydown listener in `modules/dynamo/data-view/DataViewTab.tsx` / `modules/postgres/data/TableViewerTab.tsx`, and the fuzzy scorer `fuzzySubsequenceScore` in `platform/command-palette/scoreTableEntry.ts`.

## Key decisions

### 1. ⌘F → inline filter bar, scoped to the active events tab

Add a `window` keydown listener gated on `active`, mirroring `DataViewTab`:

```
if ((meta||ctrl) && key==='f' && !shift && !alt):
    if focus is inside a text input/textarea/.cm-editor → ignore (let native behave)
    else preventDefault() → open the filter bar + focus its input
Esc (when the bar is open / its input focused) → close + clear
```

The bar is a compact row at the top of the events list (DESIGN.md: input `6px 10px`, hairline border, `--radius-md`), showing the input and an "N of M" count. It intercepts the browser's native find so the in-app filter is the one ⌘F surfaces, consistent with the rest of Argus.

### 2. Case-insensitive fuzzy matching over loaded events

Plain-text query, no operators. A line matches when, case-insensitively, **either**:
- the query is a substring of the message (the common, predictable case), **or**
- the query characters appear in order as a subsequence (fuzzy fallback, so scattered chars still hit).

```
matchesLog(message, query):
   const m = message.toLowerCase(), q = query.toLowerCase()
   return m.includes(q) || isSubsequence(m, q)
```

Implement a small self-contained matcher in the cloudwatch module (e.g. in `logFormat.ts`), modeled on `fuzzySubsequenceScore` but returning a boolean — no cross-module coupling to the command-palette internals. Match against the message text; timestamps are not the target (users filter by content). Empty query → everything passes.

### 3. Local-only, applied to the full loaded set

Filtering is pure client-side over the in-memory `events` array via a `useMemo` keyed on `(events, query)`. No refetch, no backend call. As "load older / newer" appends/prepends events, the same filter re-applies automatically. Clearing the query or closing the bar shows all loaded events again. The viewer stays read-only.

### 4. Empty-result state

When a non-empty query matches nothing among loaded events, show a quiet in-list message ("No events match \"<query>\".") rather than a blank area, and keep the "load older / newer" controls available so the user can pull more events into the filtered set.

## Risks / trade-offs

- **Only filters loaded events**: a match outside the loaded window won't appear until paged in. Acceptable and expected for a local find; the "N of M" count and retained paging make this clear. Account-wide search is the server-side feature's job.
- **Fuzzy noise**: substring-first keeps results intuitive; the subsequence fallback only adds matches, never removes substring hits, so it can't hide an obvious match.
- **Shortcut collision**: gating on `active` + skipping input/CodeMirror surfaces avoids stealing ⌘F from other tabs and text fields (same guard the data views use).

## Migration

None. Frontend-only, additive UI + client-side filter; backend, persistence, events, and the result/event shapes are unchanged.
