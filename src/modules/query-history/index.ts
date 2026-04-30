// Side-effect import: registers the `query-history` tab kind on load.
import "./HistoryTab";

export { QUERY_HISTORY_KIND, QUERY_HISTORY_TAB_ID } from "./HistoryTab";
export { openHistoryTab } from "./openHistoryTab";
export { useQueryHistoryCommands } from "./commands";
export { historyApi } from "./api";
export type {
  HistoryEntry,
  HistoryFilters,
  HistoryListRequest,
  HistoryListResponse,
  HistoryStatus,
  HistoryOrigin,
} from "./api";
