# ai-context-documentation Specification

## Purpose
Defines the AI agent's ability to persist conversation knowledge back into a connection's object docs through a single write-only `document_object` tool. Covers which regions are writable (body, `human.column_notes`, `human.tags`), append-vs-replace semantics, canonical-path resolution and traversal rejection, byte-preservation of untouched regions, watcher-driven refresh, and tool-call streaming to the chat UI.

## Requirements
### Requirement: Agent can document object docs via a write-only tool

The AI agent (claude-cli in v1) SHALL be able to persist knowledge into a connection's object doc through a single write-only `document_object` tool exposed by an Argus-hosted MCP server. The tool SHALL accept a connection-scoped object identity, a `target` of `body`, `column_note`, or `tags`, the `content` to write, and (for `body`) an optional `mode` of `append` (default) or `replace`. The tool SHALL NOT be able to read or write anything outside object-doc writes, execute SQL, or run a database CLI.

#### Scenario: Tool is exposed only to claude-cli in v1

- **WHEN** a chat session runs on claude-cli with a connection that has a linked context folder
- **THEN** the `document_object` tool is available to the agent
- **AND** the tool surface is write-only (it cannot execute SQL, run a DB CLI, or read/write outside the context root)

#### Scenario: Tool is unavailable without a context folder

- **WHEN** the connection has no linked context folder
- **THEN** the `document_object` tool is not offered to the agent

### Requirement: Writable regions are limited to body, column_notes, and tags

A `document_object` call SHALL only modify the Markdown body, `human.column_notes[<column>]`, or `human.tags` of the resolved object doc. It SHALL NEVER modify the `system:` frontmatter block. Regions not targeted by a call SHALL be preserved byte-for-byte, including line endings.

#### Scenario: Body append adds a dated section and preserves frontmatter

- **WHEN** the agent calls `document_object` with `target=body`, `mode=append` (or omitted)
- **THEN** the content is appended to the body under a `## Notes from chat YYYY-MM-DD` heading
- **AND** the `system:` and `human:` frontmatter blocks are unchanged byte-for-byte

#### Scenario: Body replace rewrites only the body

- **WHEN** the agent calls `document_object` with `target=body`, `mode=replace`
- **THEN** the body region is replaced with the content
- **AND** the frontmatter (`system:` and `human:`) is unchanged byte-for-byte

#### Scenario: Column note sets one human.column_notes entry

- **WHEN** the agent calls `document_object` with `target=column_note`, `column=<name>`, `content=<note>`
- **THEN** `human.column_notes[<name>]` is set to the note (replacing any prior note for that column)
- **AND** the `system:` block and the body are unchanged byte-for-byte

#### Scenario: Tags merge into human.tags without removing existing tags

- **WHEN** the agent calls `document_object` with `target=tags`, `content=<one or more tags>`
- **THEN** the tags are merged into `human.tags` as a set union (case-insensitive dedupe)
- **AND** no existing tag is removed, and the `system:` block and body are unchanged byte-for-byte

#### Scenario: column_note requires a column

- **WHEN** the agent calls `document_object` with `target=column_note` and no `column`
- **THEN** the call is rejected with an error and no file is written

#### Scenario: system block is never writable

- **WHEN** the agent attempts to document an object
- **THEN** there is no `target` value that writes into the `system:` block

### Requirement: Writes resolve the canonical doc path and stay inside the context root

The write handler SHALL resolve the target doc path from the connection's context root and the object identity using the same canonical layout as schema sync (`<root>/<engine>/<schema>/<name>.md`, Dynamo under `dynamo/tables/<name>/table.md`, folding Dynamo names through the connection's normalization rule). The resolved path SHALL be canonicalized and asserted to be a descendant of the canonical context root; `..` traversal and symlink escapes SHALL be rejected. Writes SHALL use an atomic temp-file + rename.

#### Scenario: Path resolves to the canonical layout

- **WHEN** the agent documents `public.users` on a Postgres connection rooted at `<root>`
- **THEN** the write targets `<root>/postgres/public/users.md`

#### Scenario: Dynamo identity folds through the normalization rule

- **WHEN** the agent documents a Dynamo table on a connection with a `table_match` rule
- **THEN** the physical name is folded to its logical name before resolving `<root>/dynamo/tables/<logical>/table.md`

#### Scenario: Path traversal is rejected

- **WHEN** a `document_object` call resolves to a path outside the connection's canonical context root (e.g. via `..` or a symlink)
- **THEN** the write is rejected and no file is written

#### Scenario: Documenting a not-yet-existing doc creates it under the canonical path

- **WHEN** the agent documents an object whose doc file does not yet exist
- **THEN** the engine/schema subtree is created and a new doc is written at the canonical path with the targeted region populated

### Requirement: Each write streams to the chat UI and refreshes the docs view

Each `document_object` invocation SHALL surface in the chat panel through the existing tool-call delta stream as it happens, and a successful write SHALL trigger the existing context filesystem watcher so the docs panel and structure views refresh without an explicit reload.

#### Scenario: Write streams as a tool call

- **WHEN** the agent invokes `document_object`
- **THEN** a `ToolCallStarted` delta is emitted for the call and a `ToolCallFinished` delta on completion
- **AND** the chat panel shows an indicator that the object was documented

#### Scenario: Successful write refreshes the docs view

- **WHEN** a `document_object` write completes and lands a `*.md` change inside the watched context root
- **THEN** the context watcher reparses and emits `context://changed`
- **AND** the docs panel / structure view reflect the new body, column note, or tag without a manual reload
