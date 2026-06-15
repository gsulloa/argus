## Why

The app name "Argus" is hardcoded in ~50 places across Tauri config, Rust, frontend, build scripts, and docs. Today it's an internal experiment for use at Meki, but if it ever needs to go public the name "Argus" is not legally clearable (saturated trademark in software/data tooling). We want renaming to be a one-tank-of-gas job, not a 50-file archaeology dig — so the name must live behind a single source of truth, and the handful of identifiers that break existing installs when changed must be clearly isolated and documented.

## What Changes

- Introduce a **single source of truth** for the app's display name and brand identifiers (one Rust module + one frontend constant), replacing scattered hardcoded `"Argus"` literals classified as `safe`.
- Route all `safe` display strings (window title, `<title>`, about/header text, log/UI copy) through that constant.
- Isolate the `migration`-sensitive identifiers (bundle id `com.argus.app`, keychain service `argus`, `argus.db`, `argus.log`, Cargo package/lib names, MCP sidecar command, AI env-var prefixes `ARGUS_*`) into a clearly documented, named layer — **not** silently parameterized, because changing them breaks already-installed instances. Renaming these is a deliberate, documented procedure.
- Add a short **RENAMING.md** (or section) documenting the exact steps and data-migration implications for a future rename.
- **No behavior change** for end users; the app still ships as "Argus".

## Capabilities

### New Capabilities
- `app-identity`: Defines the single source of truth for the application's name and brand identifiers, the classification of each identifier as display-safe vs migration-sensitive, and the documented procedure for renaming the app.

### Modified Capabilities
<!-- No spec-level behavior changes to existing capabilities; this is an internal refactor that centralizes branding. app-shell behavior is unchanged. -->

## Impact

- **Tauri config**: `src-tauri/tauri.conf.json` (`productName`, window `title`, `longDescription`; `identifier` stays but is documented as migration-sensitive).
- **Rust**: new `src-tauri/src/config/` (or similar) app-identity module; updates to `platform/secrets.rs`, `modules/ai/keys.rs`, `platform/storage.rs`, `lib.rs`, `platform/updater/commands.rs`, `main.rs`, `Cargo.toml`.
- **Frontend**: `index.html` `<title>`, `package.json` name, any UI strings; new shared constant in `src/`.
- **Build/CI**: `.github/workflows/release.yml`, `scripts/release-local.sh` artifact naming (safe display strings).
- **Docs**: `README.md`, `CLAUDE.md`, `DESIGN.md`, new `RENAMING.md`.
- **No new runtime dependencies.**
