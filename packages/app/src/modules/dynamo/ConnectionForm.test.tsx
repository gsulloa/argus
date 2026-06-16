import { describe, it } from "vitest";

describe("DynamoConnectionForm — list refresh contract", () => {
  // Spec: openspec/specs/dynamo-connection/spec.md
  //       "Requirement: Connection list refresh on save"
  //
  // The form persists via useConnections().create / .update so the
  // ConnectionsProvider's `items` array reflects the new/edited connection
  // within the same app session. The implementation no longer imports
  // connectionsApi.create / connectionsApi.update.
  //
  // A full integration test would mount <ConnectionsProvider> wrapping
  // <DynamoConnectionForm>, mock connectionsApi.list to return a stable
  // sequence, submit the form, and assert the provider's items array
  // contains the new row. That requires mocking @tauri-apps/api/core and
  // the dynamo Tauri commands, which is non-trivial scaffolding not yet
  // present in this module's test suite.
  it.todo("saving a new Dynamo connection updates the sidebar immediately");
  it.todo("editing a Dynamo connection updates the sidebar immediately");
  it.todo("duplicating a Dynamo connection updates the sidebar immediately");
});
