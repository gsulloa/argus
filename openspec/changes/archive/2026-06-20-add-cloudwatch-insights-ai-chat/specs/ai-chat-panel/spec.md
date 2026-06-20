## MODIFIED Requirements

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
