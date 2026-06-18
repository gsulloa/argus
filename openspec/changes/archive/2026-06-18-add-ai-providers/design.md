## Context

Argus already produces a serialised AI payload from a linked context folder (`context_ai_payload`, see `add-connection-context-folders`). The payload is small (<200 KB for 200 objects in summary mode), JSON-serialisable, and engine-agnostic. The natural next step is to consume it.

The user's directive is precise: support **four providers** — two CLIs (`claude`, `codex`) and two HTTP APIs (Anthropic, OpenAI). The CLIs are *agents*: given a working directory, they can read files autonomously. The APIs are *one-shot completions*: they take a fixed prompt and return a string. A naïve abstraction that hides this asymmetry — for instance, simulating "agentic file reading" inside the API providers — would either bloat every request with the full payload or silently degrade quality when the folder is large. Conversely, exposing the asymmetry through two separate traits would force every consumer to branch on provider kind.

The existing codebase already establishes patterns we lean on heavily:

- **Trait-based engine abstraction** in `src-tauri/src/modules/context/introspect.rs` (`IntrospectForContext`) is the closest precedent and the model we follow.
- **Keyring storage** in `src-tauri/src/platform/secrets.rs` with service `"argus"` and per-id accounts.
- **Tauri command pattern** in `src-tauri/src/modules/context/commands.rs` with `AppResult<T>` returns and `State<'_, X>` injection.
- **Frontend module structure** in `src/modules/context/` (api, types, hooks, components) which we mirror.
- **Modal UX** from `SyncReportModal` and `ContextFolderRow` — same primitives, same CSS module conventions.

## Goals / Non-Goals

**Goals:**
- One Rust trait (`AiProvider`) that accommodates all four providers without lying about their differences.
- Honest capability advertising: each provider declares what it can do; the UI reads capabilities, not provider identity.
- CLI providers run with `current_dir = connection.context_path` so they can read context files autonomously without us pre-serialising anything.
- API providers receive the pre-built `AiPayload` embedded in their system prompt.
- API keys stored via the existing `keyring` integration. No plaintext secrets in sqlite.
- Trait method returns a stream from day one so future chat / streaming UIs don't require re-architecting; the v1 generate-SQL flow collects the stream into a single string.
- One concrete user-facing feature: "✨ Generate SQL" in the Postgres `QueryEditor` toolbar.
- Settings panel reachable via command palette ("AI: Configure providers").
- Model selection: hard-coded sensible default per provider + dropdown for override.

**Non-Goals:**
- Chat / multi-turn conversation UI (deferred to a follow-up change).
- "Explain with AI" on schema nodes (deferred).
- Streaming responses in the UI (back end produces stream, UI collects in v1).
- Tool-call protocol for the API providers (they receive the static payload; they don't call back to Argus).
- Token / cost accounting and rate limiting.
- Local model support (Ollama, llama.cpp, etc.).
- Replication into MySQL / MSSQL / Dynamo editors (mechanical follow-up once Postgres proves the shape).
- Per-prompt provider override (the modal uses whatever is configured as the active provider for that connection or globally).

## Decisions

### Decision 1: Single trait + capabilities, not two traits

```rust
pub trait AiProvider: Send + Sync {
    fn id(&self) -> ProviderId;             // "claude-cli" | "codex-cli" | "anthropic-api" | "openai-api"
    fn capabilities(&self) -> Capabilities;
    async fn validate(&self) -> ValidationResult;
    async fn generate_sql(&self, req: GenerateRequest) -> AppResult<GenerateStream>;
}

pub struct GenerateRequest {
    pub prompt: String,
    pub context_path: Option<PathBuf>,   // CLIs use as cwd; APIs ignore
    pub context_payload: AiPayload,      // APIs embed in system prompt; CLIs ignore
    pub model: Option<String>,           // None = provider default
}

pub type GenerateStream = Pin<Box<dyn Stream<Item = AppResult<GenerateDelta>> + Send>>;

pub enum GenerateDelta {
    Text(String),
    Done { finish_reason: Option<String> },
}

pub struct Capabilities {
    pub can_read_files: bool,        // true for CLIs (they have cwd access)
    pub supports_streaming: bool,    // true for all four (CLIs stream stdout, APIs SSE)
    pub requires_api_key: bool,      // false for CLIs, true for APIs
    pub default_model: &'static str,
    pub available_models: &'static [&'static str],
}
```

**Why:** The information needed by every provider fits in one struct. CLIs ignore `context_payload`; APIs ignore `context_path`. The cost of "passing too much" is one `Arc<AiPayload>` clone per call (cheap — the payload is bounded at ~200 KB).

**Alternatives considered:**
- *Two separate traits (`AiCompletion`, `AiAgent`).* Cleaner conceptually but forces every consumer to branch (`match resolved { Completion(c) => …, Agent(a) => … }`) and doubles the Tauri command surface. Rejected because the consumer side (UI) only cares about "give me SQL"; provider asymmetry is an implementation detail.
- *Simulate agentic behaviour in API providers (pre-read files into the prompt).* This is what one trait without `context_path` would force. Rejected because it discards the user's explicit reason for wanting CLI providers in the first place — file selection by an agent rather than by us bundling everything.
- *Capabilities as an enum.* Rejected because adding a new capability would break match exhaustiveness everywhere. A struct of bools is forward-compatible.

### Decision 2: Stream from day one, collect in v1

```rust
async fn generate_sql(&self, req: GenerateRequest) -> AppResult<GenerateStream>;

// v1 consumer collapses it:
let stream = provider.generate_sql(req).await?;
let text = collect_stream(stream).await?;   // helper in factory
```

**Why:** Both CLIs naturally stream (stdout line-by-line); Anthropic SSE and OpenAI streaming are well-documented. Designing a `String` return now and retrofitting streaming later would mean re-doing the trait, every provider impl, every Tauri command, and the frontend wiring. The collapsing helper is ten lines.

**Alternatives considered:**
- *Return `AppResult<String>` in v1.* Rejected. Same engineering cost upstream, no benefit, painful migration.

### Decision 3: Tauri commands operate on `ProviderId`, not on dynamic trait objects

```rust
// src-tauri/src/modules/ai/commands.rs
#[tauri::command]
pub async fn ai_generate_sql(
    settings: State<'_, AiSettings>,
    secrets: State<'_, SecretsStore>,
    payload: AiPayload,
    prompt: String,
    context_path: Option<PathBuf>,
    connection_id: Option<Uuid>,   // for per-conn override
    model: Option<String>,
) -> AppResult<String> {
    let provider_id = settings.resolve_provider(connection_id).await?;
    let provider = factory::build(provider_id, &settings, &secrets).await?;
    let req = GenerateRequest { … };
    let stream = provider.generate_sql(req).await?;
    collect_stream(stream).await
}
```

**Why:** Tauri commands can't easily take `Box<dyn AiProvider>` as state because providers are per-call (config can change between calls). The factory builds a provider lazily, command-side; state holds only `AiSettings` and the existing `SecretsStore`.

**Alternatives considered:**
- *Long-lived provider singletons in app state.* Rejected because changing API keys or default model would require invalidation logic. Build-on-demand is cheaper than cache-and-invalidate for an interactive feature called once per click.

### Decision 4: Settings storage — sqlite for non-secrets, keyring for secrets

```sql
-- 0006_ai_settings.sql
CREATE TABLE ai_settings (
    id                    INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
    default_provider      TEXT,                                -- nullable until user configures
    claude_cli_model      TEXT,                                -- nullable = use provider default
    codex_cli_model       TEXT,
    anthropic_api_model   TEXT,
    openai_api_model      TEXT,
    updated_at            TEXT NOT NULL
);

CREATE TABLE ai_connection_overrides (
    connection_id   TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
    provider_id     TEXT NOT NULL,
    model           TEXT
);
```

Keyring accounts:
- `service = "argus"`, `account = "ai:anthropic"` → API key
- `service = "argus"`, `account = "ai:openai"` → API key

**Why:** Singleton-row pattern is simple and easy to migrate; per-connection overrides are sparse and naturally a separate table. Keys never touch sqlite (same invariant as connection passwords).

**Alternatives considered:**
- *JSON blob in a key-value table.* Rejected — we already have a sql-migration culture in this codebase; staying typed is consistent.
- *Per-connection-only configuration (no global default).* Rejected — most users will want one provider everywhere. Global default is the lowest-friction default.

### Decision 5: Provider validation is cached but invalidated on config change

```rust
pub struct ValidationCache {
    entries: HashMap<ProviderId, (ValidationResult, Instant)>,
}
// TTL: 60 seconds. Force-revalidate when API key changes or settings change.
```

**Why:** Probing `claude --version` is fast (~50ms) but probing the Anthropic API with a 1-token request is slow (~500ms) and costs money. Caching for 60s is fine for an interactive UI; the cache is dropped/re-checked on settings panel open.

**Alternatives considered:**
- *No cache; revalidate every modal open.* Rejected — costs accumulate, and the failure modes (no internet, expired key) don't change second-by-second.
- *Indefinite cache.* Rejected — when a user pastes a new API key, they expect immediate feedback.

### Decision 6: CLI invocation — `tokio::process::Command`, non-interactive mode, stdout = generated SQL

```rust
// claude_cli.rs (illustrative)
let mut cmd = tokio::process::Command::new("claude");
cmd.arg("-p")                                  // print mode (non-interactive)
   .arg(build_cli_prompt(&req.prompt))         // includes "respond with only the SQL block"
   .current_dir(req.context_path.unwrap_or_else(|| std::env::temp_dir()))
   .stdout(Stdio::piped())
   .stderr(Stdio::piped());
if let Some(model) = &req.model {
    cmd.args(["--model", model]);
}
let child = cmd.spawn().map_err(map_spawn_err)?;
// stream stdout line-by-line as GenerateDelta::Text(line)
```

Codex follows the same pattern with its own flags. Both expect the user to be authenticated at the CLI level — we don't manage their auth.

**Why:** Both CLIs document non-interactive modes that print to stdout. We avoid spawning interactive shells. Streaming stdout means we can emit `GenerateDelta::Text` incrementally for free (v1 collects, but the stream is real).

**Risks:**
- The user's `claude` CLI version might predate `--model` or `-p`. The validation step runs `--version` and could capture the version string; we keep things lenient — pass `--model` only if specified and let the CLI error out clearly.
- macOS GUI app context might not include `$PATH` extensions where `claude`/`codex` live. We accept this and document it in the "validation failed" hint: "Could not find `claude` in PATH. If installed, try launching Argus from a terminal once or add the CLI to /usr/local/bin." Configurable absolute path is a follow-up.

### Decision 7: API invocation — `reqwest`, system prompt embeds the payload as JSON

```rust
// anthropic_api.rs (illustrative)
let body = json!({
    "model": req.model.unwrap_or(DEFAULT_ANTHROPIC_MODEL),
    "max_tokens": 4096,
    "system": format!(
        "{}\n\n# Database context\n```json\n{}\n```\n\nRespond with only a SQL block, no prose.",
        SYSTEM_PREAMBLE,
        serde_json::to_string_pretty(&req.context_payload)?
    ),
    "messages": [{ "role": "user", "content": req.prompt }],
});
let resp = client.post("https://api.anthropic.com/v1/messages")
    .header("x-api-key", key)
    .header("anthropic-version", "2023-06-01")
    .json(&body)
    .send().await?;
```

We extract the SQL block from the response (markdown fenced block parsing — same heuristic as Codex CLI output) before returning.

**Why:** Payload is small enough (<200 KB summary mode) to embed entirely. No tool-use protocol needed: APIs are intentionally one-shot in v1. SQL extraction is a single regex; we don't try to be clever.

**Risks:**
- A payload approaching the 200 KB ceiling pushes near 50-80k tokens (model-dependent). Anthropic's Claude 4 / 4.5 windows are 200K, OpenAI GPT-4 is 128K — both fine. We document the ceiling and let `body_summary` mode keep it tight.
- Provider may return reasoning or commentary alongside the SQL block. The "respond with only a SQL block" instruction is the cheapest mitigation; if it proves unreliable, we strengthen the prompt or post-process more aggressively.

### Decision 8: Default models — hardcoded constants, dropdown overrides

```rust
pub const CLAUDE_CLI_DEFAULT_MODEL: &str = "claude-opus-4-7";
pub const CLAUDE_CLI_MODELS: &[&str] = &["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"];

pub const CODEX_CLI_DEFAULT_MODEL: &str = "gpt-5.1";        // or whichever Codex CLI ships with
pub const CODEX_CLI_MODELS: &[&str] = &["gpt-5.1", "o3-mini"];

pub const ANTHROPIC_API_DEFAULT_MODEL: &str = "claude-opus-4-7";
pub const ANTHROPIC_API_MODELS: &[&str] = &["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"];

pub const OPENAI_API_DEFAULT_MODEL: &str = "gpt-4o";
pub const OPENAI_API_MODELS: &[&str] = &["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"];
```

**Why:** Hardcoded gives stable defaults users don't need to think about. A dropdown gives the override path for power users without exposing an unbounded text field (and the typos that come with it). Lists update when we update the binary — acceptable cadence.

**Alternatives considered:**
- *Free-form model text input.* Rejected — typos, no validation, looks unfinished. The dropdown supports a "Custom…" entry as a future addition if we need it.
- *Fetch model list dynamically from each provider's `/models` endpoint.* Rejected for v1 — adds a network call, doesn't apply to CLIs, and the curated list better reflects "models we've actually tested for SQL".

### Decision 9: UI — "✨" button in QueryEditor toolbar, modal with provider/model dropdowns

```
┌────────────────────────────────────────────┐
│ [▶ Run] [💾 Save] [✨ AI]      │ ← toolbar │
│ ┌────────────────────────────────────────┐ │
│ │  SELECT * FROM users …                  │ │
│ └────────────────────────────────────────┘ │
└────────────────────────────────────────────┘

Modal:
┌─────────────────────────────────────────────┐
│  ✨ Generate SQL                             │
│  ┌────────────────────────────────────────┐ │
│  │ Describe what you want:                │ │
│  │ ┌──────────────────────────────────┐   │ │
│  │ │ top 10 customers this month       │   │ │
│  │ │ ordered by total spend            │   │ │
│  │ └──────────────────────────────────┘   │ │
│  │                                        │ │
│  │ Provider: [claude-cli ▼]               │ │
│  │ Model:    [claude-opus-4-7 ▼]          │ │
│  │                                        │ │
│  │ Output:                                │ │
│  │ ┌──────────────────────────────────┐   │ │
│  │ │ SELECT u.email, SUM(o.total)…    │   │ │
│  │ └──────────────────────────────────┘   │ │
│  │                                        │ │
│  │ [Insert into editor] [Replace] [Cancel]│ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

States: idle, generating (spinner + "Cancel"), success (output + buttons), error (message + retry).

**Why:** A toolbar button is the lowest-friction entry from the existing UI. The modal is small enough to skip a side-panel commitment. "Insert / Replace / Cancel" matches user mental model from copy-paste flow.

**Alternatives considered:**
- *Side panel.* Rejected for v1 — heavier UI commitment for a one-shot operation. Becomes relevant when chat ships.
- *Inline generation directly in the editor (ghost text).* Rejected — more invasive Monaco integration; revisit if the modal feels slow.

### Decision 10: Settings panel lives in command palette, not a settings page

A new command-palette entry `"AI: Configure providers"` opens a modal showing:
- Default provider radio group (only validated providers selectable; unvalidated show inline hint).
- Per-provider sub-section: model dropdown, API key input (if applicable), validation status.
- "Save" / "Cancel".

**Why:** Argus has no general settings page today. Adding one for this single feature would be heavier than the feature warrants. The command palette is where power-user actions already live. When a real settings page exists, the panel migrates there with no API change.

## Risks / Trade-offs

- **[CLI not found in macOS GUI PATH]** → Mitigation: validation hint mentions launching from terminal or adding to `/usr/local/bin`. Configurable absolute-path setting is a follow-up.
- **[Provider model lists go stale between releases]** → Mitigation: model dropdowns are curated lists in code; we accept a release cadence for updates. A "Custom…" entry can be added later if needed.
- **[Large context payloads near the token ceiling]** → Mitigation: summary mode keeps payload <200 KB; for users opting into full-bodies, we document the trade-off. Future work could token-count and warn.
- **[CLI hangs on `claude --version`]** → Mitigation: 3s timeout on validation; treat timeout as `Missing { hint: "claude command did not respond within 3 seconds" }`.
- **[User has both `claude` CLI and Anthropic API key]** → Both providers validate and both show in the dropdown. The user's `default_provider` setting picks one; the modal can override per-call (future). For v1 the user picks once in settings.
- **[Generated SQL contains destructive statements]** → Mitigation: nothing automatic — the SQL goes into the editor, the user runs it themselves. We don't auto-execute. The existing edit-mode safeguards in Argus apply.
- **[Streaming trait is unused in v1 — over-engineering risk]** → The collapsing helper is ~10 lines and providers naturally stream; the only "cost" is the type signature. We accept this as cheap future-proofing.

## Migration Plan

1. Run the new migration; sqlite gains two tables, both empty.
2. No user-visible change until the user opens the new command-palette entry. The "✨" button is hidden when no provider is configured (no provider = nothing to do).
3. The `add-connection-context-folders` feature continues to work unchanged.
4. Rollback: deleting the `0006_ai_settings.sql` is reversible (the schema additions are isolated). API keys remain in keychain even after rollback; the user can clear them via Keychain Access if desired.

## Open Questions

- **Codex CLI flags.** The OpenAI Codex CLI surface has changed historically; the exact non-interactive invocation (`codex -p`? `codex exec`? `codex --prompt`?) needs verification at implementation time. Implementation tasks should start with a short spike: run `codex --help` and adjust the spawn signature accordingly.
- **Streaming for the API providers — SSE parsing.** Anthropic and OpenAI both support SSE streaming with slightly different event schemas. We pick the simplest path: non-streaming HTTP for v1 (request/response), wrap the single response in a one-shot stream. Real SSE wiring is a follow-up when chat lands.
- **"Did the SQL block parse cleanly?"** When a provider returns prose around the SQL, we extract the first fenced code block. If none is found we return the raw text and let the user clean it up. Acceptable for v1; a "regenerate" button covers the failure case.
