// CloudWatch Logs frontend module

export { CloudwatchIcon } from "./icon";
export { cloudwatchApi } from "./api";
export * from "./types";
export { useActiveCloudwatchConnections } from "./useActiveConnections";
export { CloudwatchConnectionForm } from "./ConnectionForm";
export { CloudwatchFormProvider, useCloudwatchForm } from "./FormController";

// Log groups tree
export { LogGroupsTree, CloudwatchInsightsPrimaryAction } from "./schema/LogGroupsTree";

// Events tab
export { openEventsTab } from "./events/openEventsTab";
export { CLOUDWATCH_EVENTS_KIND } from "./events/EventsTab";

// Insights
export { CLOUDWATCH_INSIGHTS_KIND } from "./insights/QueryTab";
export { openInsightsTab } from "./insights/openInsightsTab";
export type { OpenInsightsTabArgs } from "./insights/openInsightsTab";

// Register tab kinds via side-effect imports.
// These MUST be bare imports so TabRegistry.register() is called regardless
// of tree-shaking — same pattern as athena/mysql/mssql index.ts.
import "./insights/QueryTab";
import "./events/EventsTab";
