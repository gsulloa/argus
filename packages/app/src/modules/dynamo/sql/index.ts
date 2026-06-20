/**
 * DynamoDB PartiQL editor barrel.
 *
 * Side-effect import of QueryTab ensures TabRegistry.register() runs at
 * module load time (value import, not `export type`).
 */

// Side-effect import — triggers TabRegistry.register(DYNAMO_QUERY_KIND, ...)
import "./QueryTab";

// Export the tab kind constant as a value so callers can reference it
// without triggering a circular import via the full QueryTab module.
export { DYNAMO_QUERY_KIND } from "./QueryTab";

// Export the tab opener helper for group-4 wiring
export { openDynamoPartiQLTab } from "./openDynamoPartiQLTab";

// Export payload type for external consumers
export type { DynamoQueryPayload } from "./QueryTab";

// Export API types for external consumers
export type { RunPartiQLResult, PartiQLStatementOutcome } from "./api";
