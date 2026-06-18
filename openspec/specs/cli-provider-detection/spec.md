# cli-provider-detection Specification

## Purpose
TBD - created by archiving change harden-cli-detection. Update Purpose after archive.
## Requirements
### Requirement: Canonical binary path resolution

The system SHALL resolve a single canonical path for each local CLI provider
binary (`claude`, `codex`) and use that same path for both validation and for
spawning the provider, so that a provider which validates as available also runs.

Resolution SHALL proceed in this order, stopping at the first match:

1. The provider's explicit environment override (`ARGUS_CLAUDE_BIN`,
   `ARGUS_CODEX_BIN`) when set and non-empty.
2. A lookup of the binary name on the current process `PATH` (which has been
   enriched per "Shell PATH enrichment").
3. A fixed list of well-known install locations (see "Fallback candidate
   paths").

If no candidate resolves, the provider SHALL be reported as unavailable with a
diagnostic (see "Detection diagnostics").

#### Scenario: Environment override wins

- **WHEN** `ARGUS_CLAUDE_BIN` is set to an existing executable path
- **THEN** that path SHALL be used for validation and spawning without consulting PATH or fallback locations

#### Scenario: PATH lookup resolves the binary

- **WHEN** no override is set and `claude` is found on the enriched process PATH
- **THEN** the resolved absolute path SHALL be used for both validation and spawning

#### Scenario: Validated path is the executed path

- **WHEN** detection resolves a provider binary to a path and reports it available
- **THEN** a subsequent chat/generate run SHALL spawn that same resolved path rather than re-resolving a bare command name that may resolve differently

### Requirement: Shell PATH enrichment

On macOS, before detection runs, the system SHALL enrich the process `PATH` by
probing the user's shell so that CLI tools installed via Homebrew, npm, bun,
cargo, nvm, fnm, asdf, and Volta are discoverable when the app is launched from
Finder, the Dock, or the auto-updater (where launchd provides only a minimal
PATH).

The probe SHALL run the shell as an **interactive login** shell so that
directories added in interactive startup files (`~/.zshrc`, `~/.bashrc`) are
included, not only those in login files (`~/.zprofile`, `~/.zlogin`). The probe
SHALL redirect stdin from `/dev/null` to avoid blocking on interactive prompts.

The probe SHALL be bounded by a timeout sized for slow interactive shells. If
the probe times out, errors, or yields no usable entries, enrichment SHALL be
skipped without crashing, and the reason SHALL be recorded for diagnostics.

This requirement is a no-op on non-macOS platforms.

#### Scenario: PATH entry from interactive rc file is captured

- **WHEN** the user adds a directory to `PATH` in `~/.zshrc` (e.g. an nvm/fnm-managed node bin) and launches the app from the Dock
- **THEN** that directory SHALL be present on the process PATH after enrichment

#### Scenario: Slow shell does not break enrichment

- **WHEN** the shell probe exceeds the timeout
- **THEN** enrichment SHALL be skipped, the app SHALL continue startup, and the timeout SHALL be recorded as a diagnostic reason

#### Scenario: Probe does not hang on prompts

- **WHEN** the user's interactive shell would normally read from stdin at startup
- **THEN** the probe SHALL not block, because stdin is redirected from `/dev/null`

### Requirement: Non-POSIX shell handling

The PATH-enrichment probe SHALL produce correct results for shells whose `PATH`
representation is not colon-delimited (notably `fish`, whose `$PATH` is a
space-separated list). The system SHALL either invoke a POSIX-compatible shell
for the probe or use shell-appropriate syntax so that the extracted entries are
parsed correctly rather than collapsing to zero usable entries.

#### Scenario: fish login shell yields usable entries

- **WHEN** the user's login shell is `fish`
- **THEN** the probe SHALL extract the individual PATH directories correctly rather than treating the entire space-separated list as one unparsable entry

### Requirement: Fallback candidate paths

When a provider binary is not found on the enriched PATH, the system SHALL probe
a fixed list of well-known install locations for that binary before reporting it
unavailable. The list SHALL include, where applicable to the platform:
`~/.claude/local/claude`, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`,
and the resolved npm/bun global bin directory. A candidate SHALL be accepted
only if the file exists and responds to a version probe.

#### Scenario: Binary found in a well-known location off PATH

- **WHEN** `claude` is not on the process PATH but exists at `~/.claude/local/claude` and responds to `--version`
- **THEN** detection SHALL report the provider available using that path

#### Scenario: No candidate found

- **WHEN** the binary is absent from PATH and from every fallback candidate location
- **THEN** detection SHALL report the provider unavailable with a diagnostic listing where it looked

### Requirement: Detection diagnostics

When a local CLI provider is reported unavailable, the system SHALL surface an
actionable diagnostic that distinguishes the failure cause — at minimum: PATH
enrichment was skipped (and why: shell timed out / probe errored / no entries),
versus the binary was not found in any candidate location. The diagnostic SHALL
include the remediation options already documented (ensure the CLI is on the
login-shell PATH, symlink it into `/usr/local/bin`, or set the
`ARGUS_CLAUDE_BIN` / `ARGUS_CODEX_BIN` environment variable).

#### Scenario: Diagnostic explains a skipped PATH enrichment

- **WHEN** PATH enrichment was skipped because the shell probe timed out and the binary is consequently not found
- **THEN** the unavailable diagnostic SHALL indicate the shell-probe failure as a likely cause, not merely "command not found"

#### Scenario: Diagnostic offers remediation

- **WHEN** a provider is reported unavailable for any reason
- **THEN** the diagnostic SHALL include the environment-variable override and PATH/symlink remediation options

### Requirement: Detection applies uniformly to all local CLI providers

The system SHALL apply the detection behavior defined by this capability
(canonical path resolution, fallback candidate paths, environment overrides, and
diagnostics) identically to every local CLI AI provider, namely Claude Code and
OpenAI Codex, using each provider's own binary name and environment-override
variable.

#### Scenario: Codex provider benefits from the same hardening

- **WHEN** the `codex` binary is reachable only via an interactive-rc PATH entry or a fallback candidate location
- **THEN** the Codex provider SHALL be detected available under the same rules as the Claude provider, using `ARGUS_CODEX_BIN` as its override

