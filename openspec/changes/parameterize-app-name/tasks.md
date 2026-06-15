## 1. Rust app-identity module

- [x] 1.1 Create `src-tauri/src/config/app_identity.rs` (and register the `config` module in `lib.rs`/`main.rs` as needed)
- [x] 1.2 Define `pub const APP_DISPLAY_NAME: &str = "Argus";` as the single display-name source for Rust
- [x] 1.3 Add migration-sensitive identifiers as named, annotated constants in the same module: `BUNDLE_IDENTIFIER` (`com.argus.app`), `KEYCHAIN_SERVICE` (`argus`), `DB_FILENAME` (`argus.db`), `LOG_FILE_STEM` (`argus.log`), `CARGO_BIN_NAME` (`argus`), `MCP_SIDECAR_COMMAND` (`argus`), `ENV_VAR_PREFIX` (`ARGUS`) — each with a doc-comment stating what breaks if changed
- [x] 1.4 Add a top-of-file doc-comment: changing `APP_DISPLAY_NAME` does NOT rename an existing install; see `RENAMING.md`

## 2. Route Rust display-safe usages through the constant

- [x] 2.1 Replace `safe` `"Argus"` literals in `src-tauri/src/lib.rs` and `main.rs` (window title set in code, error/eprintln copy) with `APP_DISPLAY_NAME`
- [x] 2.2 Annotate keychain service in `platform/secrets.rs` and `modules/ai/keys.rs` to reference `KEYCHAIN_SERVICE` (value unchanged) with migration-sensitive comment
- [x] 2.3 Annotate `argus.db` in `platform/storage.rs` to reference `DB_FILENAME` (value unchanged) with migration-sensitive comment
- [x] 2.4 Annotate `argus.log` usages in `lib.rs` and `platform/updater/commands.rs` to reference `LOG_FILE_STEM` (value unchanged) with migration-sensitive comment
- [x] 2.5 Annotate the MCP sidecar command in `main.rs` as coupled to `CARGO_BIN_NAME` (value unchanged)
- [x] 2.6 Leave AI env-var names (`ARGUS_*`) as-is but document them as deriving from `ENV_VAR_PREFIX`

## 3. Frontend app-identity constant

- [x] 3.1 Create a single shared constant, e.g. `src/lib/app-identity.ts` exporting `APP_DISPLAY_NAME = "Argus"`
- [x] 3.2 Replace `safe` `"Argus"` display strings in frontend (headers, about dialog, any UI copy) with the constant
- [x] 3.3 Set `document.title` / page title from the constant, or inject `index.html` `<title>` from it at build time (whichever is simplest in the existing Vite setup)

## 4. Static config + build (documented, not parameterized)

- [x] 4.1 Confirm `tauri.conf.json` `productName`, window `title`, `longDescription` remain `"Argus"` and are listed in `RENAMING.md` (these cannot reference a Rust const)
- [x] 4.2 Confirm `package.json` `name` and `index.html` `<title>` source-of-truth decision matches task 3.3
- [x] 4.3 Leave CI/release artifact naming (`.github/workflows/release.yml`, `scripts/release-local.sh`) as `Argus_*` and list in `RENAMING.md` (safe display strings)

## 5. RENAMING.md documentation

- [x] 5.1 Create `RENAMING.md` with two sections: "Display-safe (change freely)" and "Migration-sensitive (breaks existing installs)"
- [x] 5.2 Under display-safe: list every file + key to edit (Rust constant, frontend constant, `tauri.conf.json` keys, `package.json`, `index.html`, CI artifact names, README/DESIGN/CLAUDE docs)
- [x] 5.3 Under migration-sensitive: list each identifier with its data-loss consequence and the migration step required (keychain re-key, db file rename-on-startup, bundle-id/code-signing transition, Cargo name ↔ MCP sidecar coupling)
- [x] 5.4 Add a one-line note at the top: this change made renaming *cheaper*, not *automatic*

## 6. Verification

- [x] 6.1 Run `grep -ri argus src/ src-tauri/src/ index.html` and confirm remaining hits are only: the identity module(s), migration-sensitive annotated sites, and intentional doc text
- [x] 6.2 Build the app (`pnpm tauri build` or dev) and confirm window title, page title, and about text still read "Argus"
- [x] 6.3 Smoke-test that an existing install's keychain keys, `argus.db`, and logs are still found (no migration-sensitive value changed)
- [x] 6.4 Sanity-check a hypothetical rename by temporarily changing only `APP_DISPLAY_NAME` in both constants and confirming display surfaces update while persisted-state paths do not (then revert)
