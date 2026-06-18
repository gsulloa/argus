## 1. Shell PATH enrichment (path_fix.rs)

- [x] 1.1 Switch the shell probe from `[-l, -c, …]` to interactive login `[-i, -l, -c, …]` and add `.stdin(Stdio::null())` to avoid blocking on prompts.
- [x] 1.2 Raise the login-shell probe `recv_timeout` from 2s to 5s.
- [x] 1.3 Add shell-family detection on the `$SHELL` basename; for `fish`, run the probe with fish-native syntax (`string join : $PATH`) wrapped in the existing `__ARGUS_PATH_START__:…:__ARGUS_PATH_END__` markers (or route through a POSIX shell) so the colon-delimited parse stays valid.
- [x] 1.4 Record the enrichment outcome in a process-global readable by the resolver: `Succeeded` / `Skipped { reason: Timeout | ShellError | NoEntries | NotMacos }`.
- [x] 1.5 Extend unit tests in `path_fix.rs`: fish-style space-separated payload parses (via the fish branch), marker-noise robustness retained, no-panic on all platforms.

## 2. Shared CLI binary resolver (new cli_detect.rs)

- [x] 2.1 Create `src-tauri/src/modules/ai/cli_detect.rs` with `resolve_cli_bin(name, env_var) -> PathBuf` implementing: (1) env override, (2) PATH lookup (iterate `PATH`, join name, check `is_file` + executable bit), (3) fallback candidates, (4) bare-name last resort.
- [x] 2.2 Implement the fallback candidate list per platform: `~/.claude/local/<name>`, `~/.local/bin/<name>`, `/opt/homebrew/bin/<name>`, `/usr/local/bin/<name>`, and resolved npm/bun global bin (`npm_config_prefix`, `BUN_INSTALL`, `~/.npm-global`, `~/.bun`); accept a candidate only if it exists and passes the existence/executable check, with `--version` confirming at validate time.
- [x] 2.3 Build the `Missing { hint }` diagnostic string from the resolver: incorporate the enrichment outcome (from 1.4) and the three remediations (login-shell PATH, `/usr/local/bin` symlink, `ARGUS_*_BIN`).
- [x] 2.4 Add a single combined `resolve-and-version-probe` entry point (`validate_cli`) so resolution does not double-spawn `--version`.
- [x] 2.5 Unit-test the resolver: env override precedence, empty-override ignored, total miss → bare-name fallback, fallback list contents, diagnostic mentioning enrichment cause + remediations.

## 3. Wire Claude provider (claude_cli.rs)

- [x] 3.1 Replace `claude_bin()` usage with the shared resolver (name `"claude"`, env `ARGUS_CLAUDE_BIN`); resolve once and reuse the path for `validate()` and `generate_sql()`/chat.
- [x] 3.2 Update `validate()` to delegate to `cli_detect::validate_cli` (keeps the 3s version-probe timeout); returns `Ready` only when the resolved path passes the probe, otherwise `Missing { hint }`.
- [x] 3.3 Ensure spawn sites (`generate_sql`, `spawn_claude_stream_json`) use the resolved path via `claude_bin()` (now a `PathBuf`), not the bare `"claude"` string.

## 4. Wire Codex provider (codex_cli.rs)

- [x] 4.1 Apply the same resolver wiring to Codex (name `"codex"`, env `ARGUS_CODEX_BIN`) for validate and spawn.
- [x] 4.2 Confirm Codex spawn sites use the resolved path.

## 5. Diagnostics surface

- [x] 5.1 Confirm `ValidationResult::Missing { hint }` carries the richer diagnostic through `commands.rs` (`ai_list_providers`) unchanged (no IPC contract change).
- [x] 5.2 Verify the frontend renders the longer hint legibly where provider validation is shown — `.radioHint` / `.cliHint` are block `<p>` with no truncation/`nowrap`, so the multi-sentence hint wraps. No change needed.

## 6. Verification

- [x] 6.1 `cargo test --lib` for `path_fix.rs` and `cli_detect.rs` passes (18 tests green); `cargo check --lib` compiles cleanly.
- [ ] 6.2 Manual: with `claude` installed only via a `~/.zshrc`-configured node version manager, launch from Finder/Dock and confirm the provider validates `Ready`.
- [ ] 6.3 Manual: with `claude` at `~/.claude/local/claude` and absent from PATH, confirm fallback detection reports `Ready`.
- [ ] 6.4 Manual: with `fish` as the login shell, confirm enrichment captures PATH entries.
- [ ] 6.5 Manual: with `claude` genuinely absent, confirm the `Missing` hint names the likely cause and the three remediations.
- [ ] 6.6 Repeat 6.2–6.5 (or a representative subset) for the Codex provider.
- [x] 6.7 `openspec validate harden-cli-detection --strict` passes.
