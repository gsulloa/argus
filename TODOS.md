# TODOS

## ai-setup-readiness

### Stale `argus.ai.panelOpen` is global across tabs/connections
**Priority:** P2
The AI chat panel open/closed state persists to a single global localStorage key
(`argus.ai.panelOpen`) read/written by every `QueryTab`. Opening the panel in one
tab makes newly opened query tabs auto-open it too, and each tab's persistence
effect races to write the key. With the `aiConfigured` gate removed, this now also
fires for connections that aren't ready (showing the setup checklist unprompted).
Consider scoping the key per connection/tab.
Noticed on branch `gsulloa/explore-issue-71` (pre-landing review).

### ChatSession torn down on transient readiness flips
**Priority:** P2
`ChatPanel`'s session effect depends on `[open, ready, connectionId]`. A transient
readiness downgrade (e.g. an event-bus re-check briefly going `unknown`/`missing`)
closes the live `ChatSession` and mints a new one mid-conversation, discarding
turns. The `useAiReadiness` stale-result guard (added this branch) reduces the race
window but does not prevent a genuine downgrade from tearing down an active stream.
Consider not tearing down an active streaming session on readiness downgrade.
Noticed on branch `gsulloa/explore-issue-71` (pre-landing review).

### Confirm readiness dot color against DESIGN.md
**Priority:** P2
The SQL editor toolbar readiness dot uses `--warning` (amber) for the "setup
needed" state (`QueryTab.module.css` `.aiDotSetup`). DESIGN.md mandates a single
violet accent with restrained color. Confirm a persistent amber status dot on the
primary toolbar is allowed; if not, switch to the violet accent or a muted/neutral
dot for the unmet state.
Noticed on branch `gsulloa/explore-issue-71` (pre-landing review).

## dynamo

### Flaky concurrency-cap test in CacheProvider
**Priority:** P2
`src/modules/dynamo/tables/CacheProvider.test.tsx` →
"dispatches at most 8 concurrent describe calls when 20 are queued" fails
intermittently (~1 in 3 runs) with `expected "vi.fn()" to be called at least
once`. Timing-dependent assertion on concurrency dispatch; pre-existing, unrelated
to AI/welcome work. Make the test deterministic (await scheduling instead of
relying on microtask timing).
Noticed on branch `gsulloa/explore-issue-71` (full test run during /ship).

## Completed
