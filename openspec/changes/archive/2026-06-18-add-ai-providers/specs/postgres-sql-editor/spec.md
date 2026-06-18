## ADDED Requirements

### Requirement: "Generate SQL" toolbar affordance

The Postgres SQL editor toolbar (`src/modules/postgres/sql/QueryEditor.tsx`) MUST host a "✨ Generate" button positioned after the existing "Save" button and styled consistently with the existing toolbar buttons. The button's visibility, click behaviour, and modal coupling are specified in the `ai-sql-generation` capability. The existing run / save / read-only behaviours of the editor MUST be unchanged by this addition.

#### Scenario: Button placement does not disturb existing toolbar

- **WHEN** the Postgres `QueryEditor` is rendered with AI configured
- **THEN** the toolbar contains, in order: "▶ Run", "💾 Save", "✨ Generate", followed by any other existing controls
- **AND** the visual styling of "Run" and "Save" is unchanged

#### Scenario: Run behaviour unchanged with AI configured

- **GIVEN** AI is configured and the "✨ Generate" button is visible
- **WHEN** the user types `"SELECT 1;"` and clicks "▶ Run"
- **THEN** the existing `postgres_run_sql` flow executes exactly as it did before this change
- **AND** the activity-log event emitted is identical to the pre-change behaviour
