export { POSTGRES_QUERY_KIND, type PostgresQueryPayload } from "./QueryTab";
// Importing QueryTab here also runs its TabRegistry.register side-effect.
import "./QueryTab";
export { openQueryTab } from "./openQueryTab";
export { sqlApi, type RunSqlResult, type RunManyOutcome, type Origin } from "./api";
export { splitStatements, getStatementUnderCursor } from "./splitStatements";
