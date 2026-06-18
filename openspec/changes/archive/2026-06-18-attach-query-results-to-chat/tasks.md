## 1. Wire shape (`types.rs`)

- [x] 1.1 Add `AttachedResult { id: String, columns: Vec<String>, rows: Vec<Vec<String>>, truncated: bool, row_count: usize }` (Serialize/Deserialize) to `src-tauri/src/modules/ai/types.rs`
- [x] 1.2 Add `attached_results: Vec<AttachedResult>` field to `ChatRequest` (additive; default empty)
- [x] 1.3 Extend `build_api_system_prompt` signature to `(payload: &AiPayload, attachments: &[AttachedResult])`; when attachments non-empty, build a `# Attached results` section and `sections.push(...)` it before the final `sections.join(...)` (fill the reserved trailing slot); leave output byte-identical when empty

## 2. API providers (`anthropic_api.rs`, `openai_api.rs`)

- [x] 2.1 Pass `&req.attached_results` into the `build_api_system_prompt` call site in `anthropic_api.rs`
- [x] 2.2 Pass `&req.attached_results` into the `build_api_system_prompt` call site in `openai_api.rs`
- [x] 2.3 Add an oldest-first attachment eviction step that runs before composing the system prompt: drop the oldest attachment repeatedly until the attachments portion fits the soft cap, then let the existing `trim_turns_to_fit` handle history; share the logic between both providers
- [x] 2.4 Emit a `ChatDelta::Status` when one or more attachments are evicted

## 3. CLI providers (`claude_cli.rs`, `codex_cli.rs`)

- [x] 3.1 Add a helper that renders `&[AttachedResult]` as a fenced markdown table with a `# Attached result (N rows)` header, marking truncated results
- [x] 3.2 At the `#62` insertion points in `flatten_history_for_cli` (multi-turn and single-turn), prepend the rendered table to `last.content` when attachments are present
- [x] 3.3 Confirm codex path (`format!("{system}\n\n{history}")`) and claude `--system-prompt` injection are unaffected by the prepend

## 4. Frontend capture + state (`session.ts`, `QueryTab.tsx`)

- [x] 4.1 Define the frontend `AttachedResult` type mirroring the Rust shape; stringify cells at the boundary (`CellValue → string`, `null → "NULL"`)
- [x] 4.2 Pass `runner.state.result` (columns, rows, truncated) from `QueryTab.tsx` into `<ChatPanel/>` as a prop
- [x] 4.3 Implement capture with the 100-row / 50 KB cap, setting `truncated` and preserving true `row_count`
- [x] 4.4 Carry `attached_results` on `chatSend()` in `session.ts`

## 5. Frontend attach UI (`ChatPanel.tsx`)

- [x] 5.1 Add a composer-level "Attach result (N rows)" affordance bound to the current result
- [x] 5.2 Render attached results as removable chips above the composer (multiple allowed), using existing accent + radius tokens (no new colors)
- [x] 5.3 Clear attachments after a message is sent; ensure attachments never persist to disk

## 6. Tests

- [x] 6.1 Round-trip: attach a result → next `ChatRequest` carries it → `build_api_system_prompt` includes it as the trailing section verbatim
- [x] 6.2 No-attachment: `build_api_system_prompt(payload, &[])` is byte-identical to the prior two-section output
- [x] 6.3 Truncation: a 10k-row result is capped to 100 rows / 50 KB and marked `truncated` with the true `row_count` in the payload
- [x] 6.4 CLI: flattened prompt prepends the markdown table to the latest user turn at both insertion points, with the system prompt unaltered
- [x] 6.5 Budget eviction: oldest attachment dropped first when over the soft cap, repeating until it fits, with history not trimmed in its place, and a status delta emitted
- [x] 6.6 Run `cargo test -p <crate> modules::ai` and confirm all AI tests pass; run the frontend test suite for `ChatPanel`

## 7. Wrap-up

- [x] 7.1 `cargo check` clean; no clippy regressions in `modules::ai`
- [x] 7.2 Verify no DESIGN.md token violations in the new chips (accent + radius only)
- [x] 7.3 Update `CLAUDE.md` / `README.md` AI-provider notes if the attach affordance warrants a mention
