# Renaming the app

> This document made renaming **cheaper**, not **automatic**. There is no single
> switch. Display surfaces flow from one constant per layer; a handful of
> identifiers are keyed-on by already-installed instances and changing them
> orphans existing user data unless you also write migration code.

The app currently ships as **Argus**. To rename it, work through the two
sections below. Start with **Display-safe** (low risk, do freely). Only touch
**Migration-sensitive** if you accept — or migrate — the data consequences.

---

## Display-safe (change freely)

These affect only what the user reads. After changing the two constants below,
most chrome updates on rebuild.

| What | Where | Notes |
|------|-------|-------|
| Rust display name | `src-tauri/src/config/app_identity.rs` → `APP_DISPLAY_NAME` | Single source for window/dialog titles set in Rust. |
| Frontend display name | `src/platform/app-identity.ts` → `APP_DISPLAY_NAME` | Single source for sidebar brand, status bar, welcome heading, `document.title`, inline UI prose. |
| Pre-hydration title | `index.html` → `<title>Argus</title>` | Static fallback shown before React mounts; `document.title` is then set from the frontend constant in `src/main.tsx`. Update for a flicker-free rename. |
| Tauri product/window labels | `src-tauri/tauri.conf.json` → `productName`, `app.windows[0].title`, `bundle.longDescription` | Static JSON — cannot reference a Rust const. Edit by hand. |
| npm package name | `package.json` → `name`, plus `homepage`/`repository`/`bugs` URLs | Cosmetic for an internal app. |
| CI / release artifact names | `.github/workflows/release.yml`, `scripts/release-local.sh` → `Argus_${VERSION}_*` and release-bot identity | Output filenames only; no build logic depends on them. |
| Docs | `README.md`, `DESIGN.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `CHANGELOG.md` | Prose. |
| **"Why Argus?" lore** | `src/platform/shell/tabs/welcome.tsx` | ⚠️ Mythology-specific brand copy ("Argus Panoptes, the all-seeing"). **Not** a mechanical substitution — rewrite by hand so it reads sensibly under the new name. |
| Brand prose in code | AI system prompts ("embedded in Argus, a database inspection tool" in `modules/ai/types.rs`), CLI error hints ("Argus tried to inherit your shell PATH…" in `modules/ai/{cli_detect,claude_cli,codex_cli}.rs`) | User/LLM-facing sentences that name the brand. Not routed through a constant (sentence-level copy); `grep -ri argus src-tauri/src` to find and rewrite on rename. |
| Internal namespace (optional) | `[argus]` log tags, command IDs `argus.*`, custom events `argus:*`, tracing targets `argus::context`, CSS `argus-spin`/`argusSpin`, context cache dir `.argus-cache/` | An internal namespace, not display copy. Safe to leave; churning them is pointless and noisy. |

---

## Migration-sensitive (breaks existing installs)

Each value below is keyed-on by an already-installed copy of the app. Changing
it without a migration step makes existing user state unreachable — it looks
like data loss to the user. All are mirrored/annotated at
`src-tauri/src/config/app_identity.rs` (and the frontend notes in
`src/platform/app-identity.ts`).

| Identifier | Current value | Defined at | What breaks | Migration required |
|------------|---------------|-----------|-------------|--------------------|
| Bundle identifier | `com.argus.app` | `tauri.conf.json` `bundle.identifier`; mirrored in Rust `BUNDLE_IDENTIFIER` and frontend `BUNDLE_IDENTIFIER` | Changes the OS app-data/config/log directory; updater signature identity; macOS code-signing | Treat as a new app, or migrate the old data dir on first launch. Re-establish code-signing/notarization and updater keys. |
| Keychain service | `argus` | Rust `KEYCHAIN_SERVICE` (`platform/secrets.rs`, `modules/ai/keys.rs`) | Every stored connection password and AI API key (`ai:anthropic`, `ai:openai`) becomes unreachable | Re-key: read from old service, write to new, delete old — or prompt the user to re-enter. |
| Database filename | `argus.db` | Rust `DB_FILENAME` (`platform/storage.rs`) | Existing connections, saved queries, history, settings appear gone | Rename the file on first launch before `open_db`. |
| Log file stem | `argus.log` | Rust `LOG_FILE_STEM` (`lib.rs` appender, `platform/updater/commands.rs` lookup) | Previously written logs no longer discovered | Low impact; optionally migrate old log files. |
| Cargo binary/lib name | `argus` / `argus_lib` | `src-tauri/Cargo.toml` `[package] name`, `[lib] name`; mirrored in Rust `CARGO_BIN_NAME` | The Claude CLI launches the MCP doc-writer sidecar as `<binary> __mcp-doc-writer`; a renamed binary breaks that integration | Update the sidecar command wherever the MCP config JSON is built, and any docs referencing the binary name. Coupled pair with `MCP_SIDECAR_SUBCOMMAND`. |
| Env-var prefix | `ARGUS` | Rust `ENV_VAR_PREFIX`; literals `ARGUS_CLAUDE_BIN` / `ARGUS_CODEX_BIN` at call sites in `modules/ai/{claude_cli,codex_cli}.rs` | Power users' existing `ARGUS_*_BIN` overrides stop being read | Support both old and new names for a deprecation window, or document the change. |
| Frontend localStorage prefix | `argus.` | keys like `argus.ai.panelOpen`, `argus.ai.panelWidth`, `argus.ai.autoApply`, `argus.recentTables.v1` | Users lose saved AI panel sizes/state and recent-tables list | Read old keys → write new on first launch, or accept the reset. |
| MCP server name | `argus` | Rust `claude_cli.rs` / `mcp_doc_sidecar.rs` (server `"name"`), frontend special-cases the `mcp__argus__document_object` tool in `ChatPanel.tsx` | The AI chat's document-tool call label/handling breaks if Rust and frontend drift | Coupled pair — change the server name in Rust **and** the `mcp__<name>__` match in `ChatPanel.tsx` together. |
| Postgres `application_name` | `argus` | Rust `modules/postgres/params.rs` | Cosmetic only — the label shown in `pg_stat_activity`/server logs | No data impact; update for consistency. |

---

## Quick checklist for a rename

1. Pick the new name; confirm trademark/domain clearance first.
2. Change `APP_DISPLAY_NAME` in **both** constants (Rust + frontend).
3. Update the static `index.html` `<title>`, `tauri.conf.json` labels, `package.json`, docs, and rewrite the welcome lore.
4. Decide, per migration-sensitive row, whether to **migrate** or **reset** — and write the migration code if migrating. The riskiest are bundle identifier, keychain service, and `argus.db`.
5. `grep -ri argus src/ src-tauri/src/ index.html` and confirm only the identity modules, annotated migration-sensitive sites, internal namespace, and intentional lore remain.
6. Rebuild; verify chrome shows the new name and an existing install still finds its data (if you migrated).
