# ai-chat-panel Specification

## Purpose
TBD - created by archiving change add-ai-chat-panel. Update Purpose after archive.
## Requirements
### Requirement: Docked chat panel in the Postgres SQL editor

The Postgres SQL editor (`QueryTab.tsx`) MUST host a docked chat panel on the right side of the editor area, rendered by a new component `src/modules/ai/components/ChatPanel.tsx`. The panel SHALL be collapsible. The "✨" toolbar button MUST toggle the panel open/closed (NOT open a modal). The panel's open/closed state and width MUST persist to `localStorage` so the layout survives page reload.

The panel MUST be visible only when AI is configured for the current connection (same condition as the existing `aiConfigured` boolean: a global default provider OR a per-connection override). When AI is not configured, the "✨" button is hidden and the panel cannot be opened.

When the user has a context-folder linked connection, the panel header MUST display a small badge indicating the folder name (or the last path component), so the user can confirm at a glance which folder the AI sees.

#### Scenario: ✨ button toggles the panel

- **GIVEN** the user is in a Postgres query tab with AI configured and the panel is closed
- **WHEN** the user clicks the "✨" toolbar button
- **THEN** the panel renders to the right of the editor
- **AND** the editor area shrinks to make room
- **WHEN** the user clicks "✨" again
- **THEN** the panel closes and the editor returns to full width

#### Scenario: Panel width persists

- **GIVEN** the user has dragged the splitter so the panel is 480px wide
- **WHEN** the user reloads the application
- **THEN** the panel reopens at 480px (read from `localStorage.argus.ai.panelWidth`)

#### Scenario: Panel hidden when AI not configured

- **GIVEN** a fresh install with no AI default provider configured
- **WHEN** the user opens a Postgres query tab
- **THEN** the "✨" button is NOT visible
- **AND** the panel cannot be opened
- **AND** no localStorage entry for `argus.ai.panelOpen` is honoured for this tab

### Requirement: Multi-turn conversation lifecycle

Each query tab MUST own exactly one `ChatSession` (frontend type in `src/modules/ai/session.ts`). The session id MUST be a UUID minted by the frontend on first open. The session MUST keep an in-memory list of turns; each `ChatTurn` records the role ("User" or "Assistant"), the message content, and any tool-use records that arrived for that turn.

When the user submits a new prompt the panel MUST:
1. Append a User turn locally and render it immediately.
2. Call `ai_chat_send` (new Tauri command) with the session id, the prompt, and the current connection id.
3. Subscribe to the Tauri event channel `ai-chat-delta:<session_id>` and route incoming `ChatDelta` values to the appropriate UI updates.
4. Append text to a single Assistant turn as `ChatDelta::Text` deltas arrive (no flicker — one message bubble grows).
5. Render tool-call events as collapsible cards inside the Assistant turn.
6. Finalise the Assistant turn on `ChatDelta::Done` (re-enables input).
7. Replace the Assistant turn with an error state on `ChatDelta::Error`, with a Retry action that re-submits the previous user prompt.

The session MUST persist for the lifetime of the query tab. Closing the tab MUST call `ai_chat_close(session_id)` so the backend evicts the session from its registry. Reopening the same tab MUST mint a NEW session id (no cross-mount persistence in v1).

#### Scenario: User sends a prompt, assistant streams a reply

- **GIVEN** the panel is open, AI is configured, and history is empty
- **WHEN** the user types "top 10 customers this month" and submits
- **THEN** a User turn appears immediately with the prompt
- **AND** an Assistant turn placeholder appears beneath it
- **AND** the Assistant turn fills with text as `Text` deltas arrive
- **AND** the input is disabled while streaming
- **WHEN** a `Done` delta arrives
- **THEN** the Assistant turn is marked finished
- **AND** the input is re-enabled and focused

#### Scenario: Tool-call events render as collapsible cards

- **GIVEN** the active provider is `claude-cli` and the chat is streaming
- **WHEN** a `ToolCallStarted { name: "Read", input: { "path": "manifest.json" } }` delta arrives
- **THEN** a collapsible card titled "Read manifest.json" renders inside the Assistant turn
- **WHEN** the matching `ToolCallFinished { output: "...", is_error: false }` delta arrives
- **THEN** the card shows a checkmark
- **AND** expanding the card reveals the truncated output

#### Scenario: Status messages render inline

- **WHEN** a `Status("reading queries/")` delta arrives
- **THEN** a single line of muted text appears under the assistant turn
- **AND** subsequent `Status` deltas replace the line (not stack)

#### Scenario: Closing the tab evicts the session

- **GIVEN** an active session with 4 turns
- **WHEN** the user closes the query tab
- **THEN** the frontend calls `ai_chat_close(session_id)`
- **AND** the backend removes the entry from its in-memory registry

### Requirement: Code block actions inside assistant messages

When an Assistant turn's content contains one or more fenced code blocks (` ```sql `, ` ```cwlogs `, ` ```json `, ` ``` `), the panel MUST render each block with three actions: **Apply** (replace editor buffer), **Insert** (insert at cursor), **Copy** (copy to clipboard). Only applicable query-language blocks — ` ```sql `, ` ```cwlogs `, and unannotated ` ``` ` — receive Apply and Insert; other languages (e.g. ` ```json `) get only Copy.

The Apply path MUST call `editorHandle.replaceBody(trimmed_query)` and move the cursor to the end. The Insert path MUST insert the query at the current cursor position, prefixing with a newline if the line is non-empty.

#### Scenario: Apply replaces the editor

- **GIVEN** the editor contains `"-- old"` and the assistant turn contains a ` ```sql SELECT 1; ``` ` block
- **WHEN** the user clicks **Apply**
- **THEN** the editor contains exactly `"SELECT 1;"`
- **AND** the cursor sits at the end of the buffer

#### Scenario: Insert at cursor

- **GIVEN** the editor contains `"SELECT 1;"` with cursor at the end
- **WHEN** the user clicks **Insert** on a block containing `"SELECT 2;"`
- **THEN** the editor contains `"SELECT 1;\nSELECT 2;"`

#### Scenario: Logs Insights block has Apply and Insert

- **GIVEN** the assistant emits a ` ```cwlogs ` block containing a Logs Insights query
- **WHEN** the panel renders that block
- **THEN** the **Apply** and **Insert** actions are both present alongside **Copy**

#### Scenario: Non-query block has no Apply/Insert

- **GIVEN** the assistant emits a ` ```json {...} ``` ` block
- **WHEN** the panel renders that block
- **THEN** only the **Copy** action is visible
- **AND** no **Apply** or **Insert** button is present

### Requirement: Auto-apply toggle

A toggle in the panel header labelled "Auto-apply" MUST exist. Its state persists to `localStorage.argus.ai.autoApply` (default: off). When the toggle is on AND an Assistant turn finishes AND the turn contains exactly one ` ```sql ` block, the panel MUST call **Apply** on that block automatically.

When the editor's buffer has been modified by the user between the AI's output starting and the turn finishing, auto-apply MUST be suppressed for that turn and a small inline notice MUST read "Editor changed since this answer — Apply manually if you want to use it."

#### Scenario: Auto-apply on single-block answer

- **GIVEN** the Auto-apply toggle is on and the editor has not been touched since the prompt was sent
- **WHEN** the assistant finishes with exactly one ` ```sql ` block containing `"SELECT 2;"`
- **THEN** the editor buffer is replaced with `"SELECT 2;"` automatically
- **AND** the chat shows an inline "Applied" badge on the block

#### Scenario: Auto-apply suppressed when editor changed

- **GIVEN** the Auto-apply toggle is on
- **WHEN** the user types into the editor while the assistant is still streaming
- **AND** the assistant then finishes with a SQL block
- **THEN** the buffer is NOT automatically modified
- **AND** the inline notice "Editor changed since this answer" appears

#### Scenario: Auto-apply suppressed when multiple SQL blocks present

- **GIVEN** Auto-apply is on
- **WHEN** an assistant turn finishes with two ` ```sql ` blocks
- **THEN** no automatic Apply occurs
- **AND** both blocks render with explicit Apply/Insert buttons

### Requirement: Cancel an in-flight turn

The panel MUST show a **Stop** button while streaming. Clicking Stop MUST call `ai_chat_cancel(session_id)` which aborts the in-flight Tokio task and (for CLI providers) kills the spawned child process. The Assistant turn MUST be finalised with whatever text arrived so far plus an inline "Stopped" indicator. The input MUST re-enable.

#### Scenario: Stop kills CLI process

- **GIVEN** a `claude-cli` chat is streaming and the child process is still running
- **WHEN** the user clicks **Stop**
- **THEN** the backend aborts the task
- **AND** the child process is killed (verified by `kill_on_drop` taking effect)
- **AND** the Assistant turn shows the partial text with a "Stopped" label

#### Scenario: Stop aborts API fetch

- **GIVEN** an `anthropic-api` chat is awaiting an HTTP response
- **WHEN** the user clicks **Stop**
- **THEN** the in-flight reqwest call is dropped
- **AND** the panel finalises the turn with a "Stopped" label

### Requirement: Provider/model badge and runtime mismatch handling

The panel header MUST display the active provider name and selected model. When the user changes the global default provider via the AI settings panel mid-chat, the active chat session MUST continue using its bound provider; a small inline notice MUST appear: `"Settings changed — new chats will use <new provider>. This chat continues with <bound provider>."`

#### Scenario: Bound provider is unchanged by mid-chat settings change

- **GIVEN** the chat is bound to `claude-cli` with 3 turns of history
- **WHEN** the user opens the AI settings panel and changes the default to `anthropic-api`
- **AND** returns to the chat tab
- **THEN** the chat header still reads "claude-cli"
- **AND** an inline notice mentions the change and that new chats will use the new provider

### Requirement: Context folder visibility

When the active connection has a linked context folder, the panel header MUST show a badge with the folder name (last path component) and a hover-tooltip with the full absolute path. When the connection has no context folder, the badge MUST read "No context folder" and a tooltip MUST explain that CLI providers will run from the system temp directory and API providers will receive an empty payload.

#### Scenario: Context folder badge present

- **GIVEN** the active connection has `context_path = "/Users/me/billing-ctx"`
- **WHEN** the panel opens
- **THEN** the header shows a badge with "billing-ctx"
- **AND** hovering reveals the full path

#### Scenario: No context folder

- **GIVEN** the active connection has `context_path = null`
- **WHEN** the panel opens
- **THEN** the header shows "No context folder"
- **AND** the tooltip explains the consequence for each provider kind

