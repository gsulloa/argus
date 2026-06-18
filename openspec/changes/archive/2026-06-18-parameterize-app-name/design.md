## Context

The app name "Argus" is hardcoded in ~50 places. An inventory classified them into two buckets:

- **`display-safe` (~40)**: window title, `<title>`, `longDescription`, README/docs, CI artifact names, env-var-overridable CLI binaries. Changing these affects only what the user reads.
- **`migration-sensitive` (~8)**: values that already-installed instances key their persisted state on. Changing them silently orphans that state:
  - `bundle.identifier` `com.argus.app` (`tauri.conf.json`) — app data dir on disk + updater signature identity + macOS code-signing.
  - keychain service `"argus"` (`platform/secrets.rs`, `modules/ai/keys.rs`) — stored API keys become unreachable.
  - `argus.db` (`platform/storage.rs`) — existing SQLite database not found → looks like data loss.
  - `argus.log*` (`lib.rs`, `platform/updater/commands.rs`) — existing logs not found.
  - Cargo `name`/`lib name` (`Cargo.toml`) — binary/symbol names; couples to the MCP sidecar command.
  - MCP sidecar command `argus __mcp-doc-writer` (`main.rs`) — must match the produced binary name.
  - AI env-var prefix `ARGUS_*` (`modules/ai/*`) — documented power-user override; safe-ish but part of the brand surface.

This is an internal experiment at Meki. The goal is *cheap future optionality*, not an actual rename now.

## Goals / Non-Goals

**Goals:**
- One source of truth per layer (Rust + frontend) for the display name.
- All `display-safe` literals routed through that source.
- `migration-sensitive` identifiers gathered, named, and annotated in one labeled module — visible, not buried.
- A `RENAMING.md` that turns a future rename into a checklist.
- Zero behavior change; app still ships as "Argus".

**Non-Goals:**
- Actually renaming the app.
- Runtime/config-file configurability of the name (no reading the name from env or a settings file at startup) — it's a compile-time constant, not a user setting.
- Auto-migrating user data when a migration-sensitive value changes (documented as manual/explicit, not automated here).
- Touching `tauri.conf.json`'s `identifier` value (only documenting it).

## Decisions

**1. Compile-time constant, not runtime config.**
The name is a `const` in Rust and an exported constant in the frontend, not an env var or settings entry read at launch. Rationale: a runtime knob adds surface (validation, partial-rename states, security of an injectable app name) for zero benefit — renaming is a deliberate dev action, not an end-user preference. Alternative considered (env/JSON-driven name) rejected as over-engineering for an internal tool.

**2. Two constants, not one shared cross-language source.**
Rust gets `src-tauri/src/config/app_identity.rs`; the frontend gets a constant in `src/` (e.g. `src/lib/app-identity.ts`). Rationale: a single shared source would require a build-time codegen step (JSON → Rust + TS) — more machinery than a 50-line internal tool warrants. The two constants are kept in sync by the `RENAMING.md` checklist. Alternative (codegen from one JSON) noted in Open Questions if the project ever outgrows this.

**3. `tauri.conf.json` stays literal; documented, not parameterized.**
Tauri config is static JSON read by the bundler; it can't reference a Rust const. `productName` and window `title` stay as `"Argus"` literals but are listed first in `RENAMING.md`. Rationale: parameterizing it would need a config-templating build step; not worth it. The Rust window title set in code (if any) routes through the constant; the config one is documented.

**4. Migration-sensitive values stay at their current string values, annotated in place + mirrored in the identity module.**
We do NOT change any migration-sensitive value in this change. We add doc-comments at each site (`// migration-sensitive: changing this orphans <X>`) and list them in the identity module + `RENAMING.md`. Rationale: visibility without risk.

## Risks / Trade-offs

- **[Two constants drift out of sync]** → `RENAMING.md` lists both as step 1; the values are identical and rarely touched. Acceptable for an internal tool.
- **[A developer assumes the name is fully parameterized and changes only the display constant, expecting a real rename]** → mitigated by the classification annotations and an explicit "this does NOT rename your install" note at the top of the identity module and `RENAMING.md`.
- **[Missed occurrence during refactor]** → after the refactor, `grep -ri argus src/ src-tauri/src/ index.html` should return only: the identity module(s), migration-sensitive annotated sites, and intentional doc text. A task verifies this.
- **[Changing Cargo lib name breaks the MCP sidecar]** → documented as a coupled pair in `RENAMING.md`; out of scope to change now.

## Migration Plan

No deployment migration — behavior is unchanged and the shipped name stays "Argus". The "migration" concern is purely *future-facing*: `RENAMING.md` documents that whoever renames later must, for migration-sensitive values, either (a) accept that existing installs lose access to old keychain/db/logs, or (b) write explicit one-time migration code (keychain re-key, db file rename-on-startup, bundle-id transition). Rollback of this refactor is a normal git revert.

## Open Questions

- If the app ever goes public and a real rename happens, do we want a build-time codegen step (one `app-identity.json` → Rust + TS) to eliminate the two-constant drift risk? Deferred until a rename is actually on the table.
