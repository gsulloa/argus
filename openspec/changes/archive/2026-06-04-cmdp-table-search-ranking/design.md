## Context

The ⌘P table quick switcher (`src/platform/command-palette/TablePalette.tsx`) renders one `Cmdk.Item` per relation; each item's `value` is the string `` `${prefix}${schema}.${name} ${connectionName}` ``. Filtering and ranking are delegated entirely to cmdk, which uses the `command-score` fuzzy scorer over that flattened string.

`command-score` does sequential character matching with gap penalties across the whole `value`. It has no awareness that `schema.name` is a hierarchical identifier, so for query `order`:

- `client.assistant_manual_pending_orders` and `client.order` both contain `order`.
- The scorer often ranks the longer, less-relevant entry **higher** because of how it weights position and total length, even though `client.order` is the obvious user intent.

This breaks the muscle memory expectation that typing the start of a table name should jump to that table. The same effect appears for any short query that happens to be a substring of a longer, unrelated table name.

The change replaces the default scorer for the table quick switcher with a deterministic tiered scorer while leaving the ⌘K command palette alone.

## Goals / Non-Goals

**Goals:**

- Exact table-name matches beat any other tier.
- Prefix matches on the table name beat substring matches on the table name; substring on the name beats matches on schema or connection.
- A `schema.fragment` query (e.g. `auth.us`) still routes through the same tiered logic: schema is matched exactly (or as prefix) against the schema segment, and the fragment is matched against the relation name with the usual exact > prefix > substring ordering.
- Behaviour degrades gracefully — non-matching entries still surface via cmdk's existing fuzzy score as a tie-breaker / fallback tier, so users can still find tables by typing only middle characters.
- Implementation is a **pure** scoring function so it can be unit-tested without rendering React.

**Non-Goals:**

- No change to the ⌘K command palette (`PaletteShell` consumers other than `TablePalette` keep the cmdk default).
- No change to recents persistence, eager loading, entry display, activation, empty states, or any other table-quick-switcher requirement.
- No new dependency. We will not pull in fuse.js / fzf-style scorers; the tiered approach plus cmdk's existing scorer as fallback is sufficient for this dataset (typically thousands of relations at most).

## Decisions

### Decision 1 — Tiered scoring function over a single fuzzy scorer

We introduce a pure function `scoreTableEntry(query, entry, fallbackScore) → number` that returns a score in a known range per tier. Tier ordering (highest to lowest), where `q` is the lowercased trimmed query and `name`, `schema`, `connectionName` are the entry fields:

1. `name === q` — exact name match.
2. `name.startsWith(q)` — prefix on name.
3. `q.includes('.')` and the segment-aware case: split `q` into `qSchema.qName`. Score by combining (schema match tier) × (name match tier) so `auth.us` against `auth.users` wins over `public.users`.
4. `name.includes(q)` — substring on name.
5. `schema === q` — exact schema match.
6. `schema.startsWith(q)` — prefix on schema.
7. `schema.includes(q)` — substring on schema.
8. `connectionName` exact / prefix / substring (one more tier).
9. Fallback: cmdk's score on the full value string. If cmdk would return `0` (no fuzzy match at all), our function returns `0` too and the row is hidden.

Each tier emits a fixed base score; the fallback adds a small fractional tie-breaker so that within the same tier, the candidate that cmdk also liked appears first.

**Alternatives considered:**

- *Two-string filter:* split the value into `name|schema connection` and pass two scores through cmdk. Rejected: cmdk only consumes one value string per item.
- *Fuse.js with weighted keys:* would solve ranking but adds a dependency and rebuilds an index on every keystroke; overkill for the tiered behaviour requested.
- *Patch the item value to put the name first:* a one-line "cheat" of using `` `${name} ${schema}.${name} ${connectionName}` ``. Rejected — still relies on `command-score`'s position heuristics which gave us this bug in the first place; not deterministic.

### Decision 2 — Recover entry parts inside the cmdk `filter` callback

cmdk's `filter` prop is `(value: string, search: string, keywords?: string[]) => number`. It does **not** receive the underlying item object. Options:

- (a) Pass `keywords={[entry.schema, entry.name, entry.connectionName, entry.kind]}` on each `Cmdk.Item` and read them in the filter. This is the cmdk-blessed way to attach searchable metadata; it also still participates in cmdk's default fuzzy scoring on each keyword.
- (b) Encode parts back into the `value` with sentinel separators and parse in the filter.

We pick **(a)**. It's the documented escape hatch, removes the need for string parsing, and the keyword array is exactly the data the scorer needs.

The `value` string keeps its current format so the cmdk-internal de-duplication and `Recent`-vs-`Tables` separation (via `valuePrefix="__recent "`) continues to work unchanged.

### Decision 3 — Plumbing through `PaletteShell`

`PaletteShell` is the shared scaffold for both palettes. We extend its props with an optional `filter?: (value, search, keywords?) => number`. If provided, it is forwarded to the `Cmdk` root; if omitted, behaviour is identical to today (cmdk default scorer). Only `TablePalette` passes a `filter`; the command palette does not.

### Decision 4 — Hide rows the scorer rejects

Today the table switcher relies on cmdk to hide non-matching items (`shouldFilter` is `true` when the search is non-empty). With a custom `filter`, a return value of `0` instructs cmdk to hide the item — same contract. We must make sure the scorer returns `0` *only* when neither tiered match nor cmdk fallback match the query.

### Decision 5 — Empty / single-segment query handling

- Empty query (`q === ""`): scorer is **not invoked** — `PaletteShell` already passes `shouldFilter=false` and the Recent group renders. Unchanged.
- Single-segment query without a dot: tiers 1, 2, 4, 5, 6, 7, then connection, then fallback. Tier 3 (schema-qualified) is skipped.
- Two-segment query with a dot: the `qSchema.qName` interpretation is tried first; if either side is empty (e.g. user typed `auth.`) we treat the non-empty side as a schema-only or name-only query and still apply tiers 1–7 accordingly.

## Risks / Trade-offs

- **[Risk] Regressing existing fuzzy behaviour** users rely on (typing middle characters of a name still matching) → Mitigation: keep cmdk's score as the final fallback tier so anything cmdk would have matched is still matched, just ranked below structured hits. Cover with unit tests that exercise mid-word matches like `usr` → `users`.

- **[Risk] Recent-group items competing with the same item in the Tables group** → Mitigation: the existing `__recent ` value prefix is preserved; when computing tiers, the scorer strips that sentinel from the value before comparing, but only uses `keywords` for the actual name/schema/connection so the prefix never contaminates ranking.

- **[Risk] Performance — running a JS scorer on every keystroke for a few thousand items** → Mitigation: the scorer is O(1) per item (a handful of string comparisons + one cmdk-score call); cmdk already runs a scorer per item per keystroke today. No new big-O cost.

- **[Trade-off] We are choosing deterministic tiering over a learned ranking** (no recency / open-frequency boost across all results). The Recent group already covers the "frequent tables" affordance, so adding such a boost is out of scope here.

- **[Risk] cmdk's `filter` API changes in a future version** → Mitigation: we already pin cmdk; if signature drifts we'll catch it at upgrade time and adjust the helper.

## Migration Plan

This is a pure ranking change. No data, no persisted state, no IPC contract. Rollout:

1. Land behind no flag — the new ranking is the same or better for every interactive case covered by tests.
2. If we discover a regression in the wild, revert is a single-commit revert that restores the cmdk default `filter`.
