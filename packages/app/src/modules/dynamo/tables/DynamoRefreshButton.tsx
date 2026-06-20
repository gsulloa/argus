import { RotateCw } from "lucide-react";
import { useDynamoTableCache } from "./CacheProvider";
import sidebarStyles from "@/platform/shell/Sidebar.module.css";

/**
 * DynamoRefreshButton — refresh-tables action for an active Dynamo connection.
 * Uses useDynamoTableCache which requires DynamoTablesCacheProvider in the tree.
 * Rendered in the Workspace identity header and in the legacy connection-row toolbar.
 */
export function DynamoRefreshButton({ connectionId }: { connectionId: string }) {
  const { refresh } = useDynamoTableCache(connectionId);
  return (
    <button
      type="button"
      aria-label="Refresh tables"
      title="Refresh tables"
      onClick={(e) => {
        e.stopPropagation();
        refresh();
      }}
      className={sidebarStyles.toolbarBtn}
    >
      <RotateCw size={13} />
    </button>
  );
}
