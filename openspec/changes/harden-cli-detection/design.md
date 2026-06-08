## Context

Local CLI AI providers are detected in two stages:

1. **Startup PATH enrichment** — `path_fix.rs::fix_macos_path()` runs the login
   shell (`$SHELL -l -c 'echo -n __ARGUS_PATH_START__:$PATH:__ARGUS_PATH_END__'`),
   parses the colon-delimited PATH from between markers, and appends any new
   entries to the process `PATH`. 2-second timeout, macOS-only, fails silently
   (warns to `tracing` only).
2. **Per-provider validation** — `claude_cli.rs::validate()` (and the identical
   `codex_cli.rs`) resolves the binary via `claude_bin()` = `$ARGUS_CLAUDE_BIN`
   or the bare string `"claude"`, then runs `run_version_probe()` =
   `Command::new(cmd).arg("--version").status()` with a 3s timeout. A spawn
   `NotFound` becomes `ValidationResult::Missing { hint }`. Results are cached
   60s (`validation_cache.rs`). The chat path (`generate_sql`) independently
   calls `Command::new(claude_bin())`, relying on the same process PATH.

The developer's environment resolves the binary; some users' environments do
not, despite the CLI working in their terminal. Identified failure modes, in
rough order of likelihood:

- **A. Login-only shell probe.** `-l` without `-i` does **not** source
  `~/.zshrc` / `~/.bashrc`. Node version managers (nvm, fnm, asdf, Volta) and
  npm-global `prefix` PATH edits live almost exclusively in interactive rc
  files. The developer's `claude` is reachable from a login PATH (Homebrew's
  `brew shellenv` in `.zprofile`, or a global install); affected users installed
  via a version manager configured in `.zshrc`. This is the leading suspect.
- **B. No fallback candidate paths.** If PATH enrichment misses, there is no
  probe of canonical locations (`~/.claude/local/claude` from the native
  installer, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, npm/bun
  global bin).
- **C. Non-POSIX shells.** `fish` expands `$PATH` to a *space-separated* list, so
  the colon-marker parse yields one giant unparsable entry → zero usable entries
  → silent skip.
- **D. Silent failure + short timeout.** Heavy interactive shells (oh-my-zsh +
  nvm) can exceed 2s; the skip is invisible, and the resulting `Missing` hint
  ("command not found") misdescribes the cause.

## Goals / Non-Goals

**Goals:**

- Detect the CLI for users who installed it via a node version manager or to a
  well-known location, without manual configuration.
- Make detection failures explainable: distinguish "PATH enrichment failed" from
  "binary genuinely absent", with remediation.
- Keep the same resolved path for validate and spawn.
- Apply the fix uniformly to Claude and Codex.

**Non-Goals:**

- Windows shell PATH enrichment (out of scope; env override + system PATH only).
- Bundling/installing the CLI for the user.
- Changing the AI readiness model (`ai-setup-readiness`) or chat protocol.
- Supporting `claude` as a shell alias/function (not a real binary — covered
  only via the env-override escape hatch).

## Decisions

### D1. Probe with an interactive login shell (`-i -l`), stdin from `/dev/null`

Change the probe command family from `[-l, -c, …]` to `[-i, -l, -c, …]` and set
`.stdin(Stdio::null())`. This matches VS Code's `fix-path` / `shell-env`
(`${shell} -ilc …`), the de-facto reference implementation, and is what makes
`.zshrc`/`.bashrc` PATH edits visible.

- *Alternative — keep `-l` only:* rejected; it is the root cause of mode A.
- *Alternative — source rc files ourselves:* rejected; brittle and shell-specific.
- *Risk:* interactive shells may print prompts, read stdin, or run slow init.
  Mitigated by `/dev/null` stdin, the existing background-thread + timeout, and
  parsing only the marker-delimited substring (noise outside markers is ignored,
  already covered by `parse_with_noise_before_and_after` test).

### D2. Raise the probe timeout to ~5s

Interactive init (oh-my-zsh, nvm lazy-load) routinely exceeds 2s. Raise the
`recv_timeout` to 5s. The probe runs once at startup on a background thread, so
the cost is bounded and off the UI thread. Record a distinct diagnostic when the
timeout fires.

- *Trade-off:* up to 5s before enrichment completes. Acceptable: validation is
  cached and the probe does not block the window from opening; first AI use is
  the only thing gated, and only on a cold, slow shell.

### D3. Shell-family aware probe

Inspect the basename of `$SHELL`. For `fish`, run the probe through a POSIX
shell instead (`/bin/zsh -ilc …` or `/bin/sh -lc …`) so `$PATH` is colon-
delimited — fish still sources its own config for the *process* PATH only if we
invoke fish, so prefer running fish with fish-native syntax
(`string join : $PATH`) wrapped in the same markers. Simpler robust option:
invoke the user's shell but, for fish, substitute the body with fish syntax;
for everything else use the POSIX body. Keep a single `parse_shell_path` that
operates on the colon-delimited marker payload regardless.

- *Alternative — always use `/bin/zsh`:* rejected; would miss PATH a user only
  configures in their actual (fish) shell config.

### D4. Resolve a canonical absolute path; add fallback candidates

Introduce a shared resolver (e.g. `resolve_cli_bin(name, env_var)` in a small
`cli_detect.rs` helper used by both providers):

1. If `$ARGUS_*_BIN` set & non-empty → use it.
2. Else `which`-style lookup of `name` on the (enriched) process PATH. Implement
   without a new dependency: iterate `PATH` entries, join `name`, check
   `is_file()` + executable. (Avoid pulling in the `which` crate unless trivial.)
3. Else iterate fallback candidates: `~/.claude/local/<name>`, `~/.local/bin/<name>`,
   `/opt/homebrew/bin/<name>`, `/usr/local/bin/<name>`, and `<npm prefix>/bin/<name>`
   / `<bun bin>/<name>` when resolvable.
4. Accept the first candidate that exists and passes `--version`.

`validate()` returns the resolved path (cached); `generate_sql`/chat reuse it.
To avoid double-probing, resolution and the version probe can be one pass.

- *Alternative — keep bare `"claude"` and trust PATH:* rejected; that is mode B.

### D5. Richer diagnostics

Record the enrichment outcome (succeeded / skipped: timeout | error | no-entries
| not-macos) in a process-global the resolver can read. When resolution fails,
build a `Missing { hint }` that names the likely cause and lists the three
remediations (login-shell PATH, `/usr/local/bin` symlink, `ARGUS_*_BIN`). If a
structured field is warranted, extend `ValidationResult::Missing` with an
optional `cause` tag; otherwise keep it in the `hint` string to avoid a
frontend contract change. **Decision:** keep `hint` (string) for v1 to minimize
surface area; revisit a structured `cause` only if the UI needs to branch.

## Risks / Trade-offs

- **Interactive shell hangs / emits to stdout** → `/dev/null` stdin + 5s timeout
  + marker-bounded parse; outside-marker noise is already discarded.
- **`-i` triggers shell config side effects** (e.g. `clear`, MOTD) → harmless;
  we read only stdout between markers, and we do not attach a tty.
- **Fallback paths could pick a stale/old binary** → only used when PATH lookup
  already failed; still gated behind a successful `--version`.
- **Probing many candidates adds latency on the failure path** → bounded list
  (~5 entries), each a cheap stat; only the matching one runs `--version`.
- **Process-global enrichment state** → set once at startup before threads read
  it (same single-threaded-startup invariant the existing `set_var` relies on).

## Migration Plan

- Pure behavioral hardening; no schema/IPC contract change if `hint` stays a
  string. No user migration required.
- Ship behind normal release. The `ARGUS_CLAUDE_BIN` / `ARGUS_CODEX_BIN` escape
  hatch remains as the guaranteed fallback for any environment still unresolved.
- Rollback: revert the `path_fix.rs` / resolver changes; env override and prior
  behavior are unaffected.

## Open Questions

- Should fallback candidate-path probing also run on Windows (e.g.
  `%LOCALAPPDATA%`, npm prefix)? Proposed: Linux yes, Windows deferred.
- Do we want a one-time "Re-detect AI providers" command-palette action to bust
  the 60s validation cache after a user fixes their PATH? (Nice-to-have; can be
  a follow-up.)
- Is a structured `ValidationResult::Missing { cause }` worth the frontend
  change, or is the hint string sufficient for v1? (Default: hint string.)
