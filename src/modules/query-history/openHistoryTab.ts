import { QUERY_HISTORY_KIND, QUERY_HISTORY_TAB_ID } from "./HistoryTab";

interface TabsApi {
  open: (input: {
    id?: string;
    kind: string;
    title: string;
    closable?: boolean;
    payload: unknown;
  }) => string;
}

/**
 * Open or focus the singleton History tab. The fixed id ensures duplicate
 * activations from the sidebar entry, the palette command, or anywhere else
 * focus the same tab instead of creating a new one.
 */
export function openHistoryTab(tabs: TabsApi): string {
  return tabs.open({
    id: QUERY_HISTORY_TAB_ID,
    kind: QUERY_HISTORY_KIND,
    title: "History",
    closable: true,
    payload: null,
  });
}
