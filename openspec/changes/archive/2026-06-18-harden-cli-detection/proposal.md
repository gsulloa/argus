## Why

Local CLI AI providers ("Claude Code" and "OpenAI Codex CLI") are detected by
running `claude --version` / `codex --version` against the process `PATH`, which
on macOS is enriched at startup by probing the user's login shell. This works
for the developer but fails for an unknown share of other users: their provider
shows as `Missing` even though the CLI is installed and works from their
terminal. The detection is environment-fragile in several independent ways, and
when it fails it does so silently, leaving users with no usable AI feature and
no actionable explanation.

## What Changes

- **Capture interactive-shell PATH, not just login-shell PATH.** Run the PATH
  probe as an interactive login shell (`-i -l -c`, matching VS Code's `fix-path`)
  so directories added in `~/.zshrc` / `~/.bashrc` (where `nvm`, `fnm`, `asdf`,
  Volta, and npm-global setups overwhelmingly live) are included. The current
  login-only (`-l`) probe never sources interactive rc files, which is the most
  likely reason it works for the developer (Homebrew / `.zprofile` PATH) but not
  for users who installed the CLI via a node version manager.
- **Probe well-known install locations directly.** When PATH lookup fails, fall
  back to a fixed list of canonical install paths (`~/.claude/local/claude`,
  `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, the resolved npm/bun
  global bin) before declaring the provider `Missing`.
- **Resolve a single canonical absolute binary path** once per detection and
  reuse it for both validation and spawning, so a CLI that validates also runs
  (and vice versa). Continue honouring `ARGUS_CLAUDE_BIN` / `ARGUS_CODEX_BIN`.
- **Handle non-POSIX login shells.** Detect `fish` (and other shells whose
  `$PATH` is not colon-delimited) and probe via a POSIX shell or fish-native
  syntax so the marker parse does not silently yield zero entries.
- **Stop failing silently.** Raise the login-shell probe timeout to accommodate
  slow interactive shells (oh-my-zsh, heavy `nvm`), and surface *why* detection
  failed (PATH enrichment skipped, shell timed out, binary not found in any
  candidate) as a diagnostic the UI can show — not only an opaque `Missing` hint.
- **Apply the same hardening to the Codex CLI provider** (identical detection
  code path today).

## Capabilities

### New Capabilities

- `cli-provider-detection`: How Argus locates and validates local CLI AI
  provider binaries (Claude Code, OpenAI Codex) robustly across heterogeneous
  user shell environments — PATH enrichment strategy, fallback candidate paths,
  canonical path resolution, environment escape hatches, and the diagnostics
  surfaced when detection fails.

### Modified Capabilities

<!-- None: provider readiness (ai-setup-readiness) gates on "a provider is
     configured", not on whether its binary is detected; the binary detection /
     ValidationResult behaviour is not currently spec'd, so it is introduced as
     a new capability rather than a delta. -->

## Impact

- **Code**: `src-tauri/src/modules/ai/path_fix.rs` (shell probe strategy,
  shell-family handling, timeout, diagnostics), `claude_cli.rs` and
  `codex_cli.rs` (canonical path resolution + fallback candidates shared via a
  helper), `commands.rs` / `types.rs` (richer `ValidationResult` diagnostic, if
  needed), and the frontend surface that renders provider validation hints.
- **Platforms**: primary impact macOS (where the PATH-fix runs); fallback
  candidate-path probing also benefits Linux. Windows behaviour unchanged for
  now (no shell PATH-fix; relies on system PATH / env override).
- **Dependencies**: none added; reuses `std::process` / `tokio::process`.
- **Risk**: interactive shells can hang or print prompts under `-i`; mitigated
  by the existing background-thread + timeout pattern and `</dev/null` stdin.
