## Why

In the QueryBuilder's "By model" mode, the per-parameter inputs give no hint about which fields must be filled for the query to run, and the sort key is locked to whatever the template's fill rule infers (equality, or `begins_with` on a trailing-empty string param). Users querying by access pattern can't see at a glance what's mandatory, and can't express range conditions on the sort key (`<`, `>`, `between`, …) the way the raw builder already allows — so "By model" mode is strictly less capable than raw for sort-key queries.

## What Changes

- **Required-field markers.** Each parameter input in "By model" mode shows a `*` next to its label when the parameter is required: every parameter that appears in the access pattern's `pk` template (partition key must always fully resolve), and — when the access pattern defines an `sk` template — every parameter that appears in the `sk` template. The marker is visual only; it does not change the value, validity, or compiled query.
- **Sort-key operator selector in "By model" mode.** When the chosen access pattern has an `sk` template (and the selected index has a sort key), the builder exposes a sort-key operator selector offering the same operators as the raw builder: `=`, `<`, `<=`, `>`, `>=`, `between`, and `begins_with`. The sort-key value(s) are still built from the access pattern's `sk` template + parameters; the chosen operator determines the emitted key condition. `between` exposes a second (upper-bound) value built from the same template. When no operator is explicitly chosen, behaviour is unchanged (the existing fill-rule inference applies), so persisted selections and existing tests keep working.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `dynamo-data-view`: the **By-model filtering mode in the QueryBuilder** requirement gains the required-field `*` markers on parameter inputs; the **Model parameter compilation to key conditions** requirement gains an explicit, user-selectable sort-key operator (the full raw-builder operator set) that overrides the implicit fill-rule sort-key behaviour while keeping the equality/`begins_with`/partition-only defaults when no operator is chosen.

## Impact

- **Frontend** (`src/modules/dynamo/data-view/`): `QueryBuilder.tsx` (render `*` markers; render the sort-key operator selector + the second value row for `between` in model mode), `modelCompiler.ts` (`compileModel` accepts an optional sort-key operator and upper-bound params and builds the `sortKey` clause accordingly), `types.ts` (`BuilderState.modelSelection` gains `skOp` and the `between` upper-bound params). Reuses the existing `BuilderState.query.sortKey` shape and the raw builder's sort-key operator vocabulary, so the downstream Scan/Query compiler is unchanged.
- **No backend changes.** Model docs, the `dynamo_model` format, the parser, and the `context_*` commands are untouched. "By model" and "Raw (PK/SK)" must still produce equivalent requests for equivalent key values.
- **Out of scope:** filter-row changes, raw-mode changes, the model editor (separate change), and any new sort-key semantics not already expressible in raw mode.
