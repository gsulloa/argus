## Context

Argus stores per-connection passwords in the OS keychain via the `keyring` crate (`src-tauri/src/platform/secrets.rs`). Every Postgres connect (`pool::load_connection_input`) and every connection-edit prefill (`ConnectionForm.tsx:209` calling `connections.getSecret`) reads the keychain fresh.

On macOS this triggers a Security framework prompt unless the binary identity has been granted "Always Allow." During development, the binary signature changes per build, so the prompt fires every run. In production, a user who has not granted "Always Allow" sees the prompt every time too. Both are avoidable: once Argus has read a secret in this session, there is no reason to ask the OS for it again until the user mutates it via Argus or restarts the app.

Today there is no in-process cache. The existing `cfg(test) mod backend` in `secrets.rs:46-79` is already a `Mutex<Option<HashMap<String, String>>>` for tests — that pattern carries directly into a real cache. The existing `pub fn get/set/delete` API funnels every secret access; wrapping those three functions internally adds the cache without touching any caller.

## Goals / Non-Goals

**Goals:**
- After the first read of a connection's secret in a process, subsequent reads MUST NOT touch the OS keychain.
- The cache MUST stay consistent with the keychain whenever Argus itself mutates the secret (`update`, `delete`, `create-with-secret`).
- Provide an explicit, supported way to recover from external keychain edits without restarting Argus (`connections.refreshSecret`).
- Zero changes to existing callsites in `pool.rs`, `connections.rs` create/update/delete paths, and the Postgres module.
- Existing `connections.rs` unit tests continue to pass without modification.

**Non-Goals:**
- TTL-based invalidation. The cache is process-lifetime by design.
- Preloading all secrets at startup. Lazy population avoids a burst of prompts on launch.
- Encryption / `Zeroize` / `mlock` of in-memory secrets. Secrets already cross IPC and live in `tokio-postgres` config in plaintext; defending against memory-dump attacks while keys are also in memory is theater.
- Detecting external keychain edits automatically. macOS does not expose a clean watch API; the manual refresh button covers the case.
- Codesigning / "Always Allow" plumbing. Orthogonal — helps prod but not dev. Separate workstream.

## Decisions

### Decision 1: Module-level static cache, not Tauri State

The cache is a `OnceLock<Mutex<HashMap<Uuid, Option<String>>>>` inside `secrets.rs`. The `pub fn get/set/delete` signatures stay byte-for-byte identical, so every existing caller (`pool.rs`, `connections.rs`, future modules) keeps working with no change.

**Alternative considered:** a `SecretCache` struct registered with `Tauri::manage()` and threaded through every callsite via `State<'_, SecretCache>`. Rejected because:

1. Five callsites would need new parameters for an internal optimization.
2. The cache is genuinely process-global (one keychain entry per id, one cache entry per id). Tauri State is for things consumers should know they depend on; this is a backend implementation detail.
3. Module statics are the precedent for this exact shape — the `cfg(test) mod backend` static `STORE: Mutex<Option<HashMap>>` is already there.

### Decision 2: Read-through, write-through, evict-on-delete

```
secrets::get(id)
  ├── if cache.peek(id) hit → return value (skip backend)
  └── miss → backend.get(id) → cache.insert(id, value) → return value

secrets::set(id, s)
  ├── backend.set(id, s)             ← keyring write first
  └── cache.insert(id, Some(s))      ← then cache update

secrets::delete(id)
  ├── backend.delete(id)             ← keyring delete first
  └── cache.remove(id)               ← then cache evict

secrets::refresh(id)
  ├── cache.remove(id)               ← evict first
  └── backend.get(id) → cache.insert(id, value) → return value
```

Backend always wins. If backend mutation fails, cache is untouched (no false-positive cache state). If cache update fails, that's a `Mutex` panic and the app crashes — acceptable, matches the existing `db poisoned` convention.

### Decision 3: Negative caching

`get(id)` for a connection without a stored secret returns `Ok(None)`. We cache the `None`. Otherwise, every "no secret" connection would hit the keyring on every connect — defeating the point. The cache map's value type is `Option<String>`, where `Some(None)` means "we asked, there is no secret" and the entry being absent means "we have not asked yet."

### Decision 4: Disconnect does NOT invalidate

`postgres_disconnect(id)` removes the active pool but leaves the cache entry intact. A subsequent `postgres_connect(id)` reuses the cached secret without prompting. This is the central UX win.

The only events that invalidate are:
- `connections.update` with `secret: Some(Some(_))` → write through
- `connections.update` with `secret: Some(None)` → evict
- `connections.delete` → evict
- `connections.refreshSecret` → evict + re-read
- App restart → cache gone

### Decision 5: New `connections.refreshSecret` command for explicit invalidation

External keychain edits (user opens macOS Keychain Access and changes the password directly) leave our cache stale. Next connect succeeds at the cache hit but fails Postgres auth. The user sees an auth error but no hint that the cause is a stale cache.

`connections.refreshSecret(id)` is the supported recovery: a button in `ConnectionForm` evicts the cache, re-reads the keychain, and replaces the prefilled password field. The command is the only path through which the cache can be reset without restarting the app.

**Alternative considered:** a `bypass_cache` flag on `connections.getSecret`. Rejected — leaks "cache" into the existing command's contract and makes the spec harder to reason about. A separate command is explicit.

### Decision 6: Sync `std::sync::Mutex`, not `tokio::sync::RwLock`

Cache access is microseconds; no `await` happens inside the lock. The Postgres pool registry uses `tokio::sync::RwLock` because acquiring a connection is async — that's not the case here. `std::sync::Mutex` is the simpler primitive for the actual concurrency profile.

### Decision 7: Cache active in tests, per-id call counters

The cache layer runs in both `cfg(test)` and `cfg(not(test))` builds. The `cfg(test) mod backend` swap continues to work — tests use the in-memory backend with the cache layered on top.

The test backend exposes a per-id `_get_call_count_for_tests(&Uuid)` helper. A global `AtomicUsize` counter would be simpler but would race between cache-specific tests and the existing `connections.rs` tests, all of which run in parallel by default and share the static backend store. Keying the counter by id means each test observes only its own calls, removing the need for a `serial_test` dependency or test-wide mutex.

The existing `connections::tests::fresh()` helper previously called `secrets::_clear_for_tests()` for hygiene. With the cache now sitting on top of the same global store, that call would race with concurrent cache tests and wipe their state mid-execution. Since every connections test uses a freshly-generated `Uuid`, the global clear is unnecessary and is removed.

## Risks / Trade-offs

- **Stale cache after external keychain edit** → User sees a Postgres auth error, no hint about the cache. Mitigation: `connections.refreshSecret` button in the connection-edit form. Documented in the spec. Capture-as-feature, not a hidden bug.

- **Memory residency of secrets** → Secrets stay in process memory until exit. Mitigation: this is already true (deadpool config, tokio-postgres internals). The cache adds at most a few hundred bytes per connection. No new threat surface that did not already exist.

- **Mutex poisoning** → If a thread panics while holding the cache mutex, subsequent accesses will themselves panic via `expect("cache poisoned")`. Mitigation: matches the existing `db poisoned` convention in `connections.rs`. The crash surfaces the bug rather than masking it.

- **Cache and backend out of sync if backend.set succeeds but cache.insert is interrupted** → Theoretical only — a `Mutex<HashMap>::insert` cannot fail under any normal condition. Not mitigated.

- **First-launch UX unchanged** → First connect of each session still prompts once per connection. Acceptable; the goal is "not every time," not "never."

## Migration Plan

No migration needed. The cache is additive and process-local. On first deploy:
- Existing connections continue to work — first read of each secret per session prompts the keychain exactly once, populating the cache.
- No database schema changes.
- No keychain entry changes.
- No IPC contract changes for existing commands. The new `connections.refreshSecret` is purely additive.

Rollback is `git revert` of the implementation PR. No data side-effects to undo.

## Open Questions

None.
