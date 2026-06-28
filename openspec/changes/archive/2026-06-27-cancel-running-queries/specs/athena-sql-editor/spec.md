## ADDED Requirements

### Requirement: Visible Stop affordance for a running query

The Athena SQL editor SHALL expose the already-present cancel path to the user: `useAthenaQueryRun` SHALL provide a `cancel()` method that, using the `query_execution_id` captured from the `athena:query-started` event, calls `athenaApi.cancelQuery` (`athena_cancel_query` → `StopQueryExecution`); and the editor toolbar SHALL render a Stop control (plus cancel shortcut) while a query is running. On cancel the editor SHALL return to idle showing a neutral cancelled state rather than rows or an error block.

#### Scenario: User cancels a running Athena query from the toolbar

- **WHEN** an Athena query is `QUEUED`/`RUNNING` and the user clicks the Stop control (or presses the cancel shortcut)
- **THEN** `StopQueryExecution` is called for the captured `QueryExecutionId` and the editor returns to idle showing "Query cancelled"
- **AND** no result rows and no error block are displayed

#### Scenario: Stop control only shown while running

- **WHEN** no Athena query is running
- **THEN** the toolbar shows Run, not Stop
