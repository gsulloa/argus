## Why

Every call to `connections.getSecret` reads the OS keychain, which on macOS prompts the user (or in dev, fails the silent-allow check because the binary signature changes per build). Opening the connection edit form, connecting after a disconnect, and reconnecting across restarts all trigger redundant prompts even though the secret has not changed. The pain is most visible to developers iterating on Argus, but also affects end users any time they have not granted "Always Allow" in Keychain Access.

## What Changes

- Add an in-process cache for secrets, keyed by connection id, sitting in front of the existing keyring backend in `src-tauri/src/platform/secrets.rs`. Cache lives for the lifetime of the process.
- Make `secrets::get` read-through: cache hit returns immediately without touching the keyring; cache miss reads keyring, populates cache, returns. Cache also stores `None` for connections without a secret (negative caching).
- Make `secrets::set` and `secrets::delete` write through: keyring mutation followed by cache insert/evict so the two layers never diverge.
- Add `secrets::refresh(id)` and a new Tauri command `connections.refreshSecret(id)` that evicts the cached entry and re-reads from the keyring. This is the supported way to recover from an external keychain edit (e.g., user changed the password directly in macOS Keychain Access) without restarting the app.
- Add a small "Re-read from Keychain" button to `ConnectionForm` (visible only when editing an existing connection) that calls `connections.refreshSecret` and replaces the password field with the result.
- Update the `connection-registry` spec to document the caching invariants and the new `connections.refreshSecret` command.

No breaking changes. Existing IPC commands keep their shapes and semantics.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `connection-registry`: adds a Secret cache invariant and a new Refresh secret requirement; existing `Get secret`, `Update connection`, and `Delete connection` requirements gain scenarios describing how the cache must be kept consistent.

## Impact

- `src-tauri/src/platform/secrets.rs`: new module-level cache, refactored `get/set/delete`, new `refresh`, expanded test backend with a call counter to verify "no keyring read on warm hit."
- `src-tauri/src/platform/connections.rs`: new `connections_refresh_secret` Tauri command.
- `src-tauri/src/lib.rs`: register the new command in the invoke handler list.
- `src/platform/connection-registry/api.ts`: add `refreshSecret(id)` IPC method.
- `src/modules/postgres/ConnectionForm.tsx`: add a "Re-read from Keychain" affordance next to the password field, visible when editing.
- `openspec/specs/connection-registry/spec.md`: spec deltas.
- No new dependencies. No database migrations. No effect on existing connections, pools, or stored secrets — first read of each secret per session still hits the keychain exactly once.
