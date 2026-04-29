import { ChevronDown, ChevronUp, PanelRight } from "lucide-react";
import { useLayout } from "./Layout";
import styles from "./StatusBar.module.css";
import { useFilteredCount } from "@/platform/activity-log/store";
import { useSetting } from "@/platform/settings/useSetting";

export function StatusBar() {
  const { inspectorOpen, toggleInspector, logsOpen, toggleLogs } = useLayout();
  const [showAuto] = useSetting<boolean>("activityLog.showAuto", false);
  const visibleCount = useFilteredCount(showAuto);
  return (
    <div className={styles.root}>
      <div className={styles.left}>
        <span className={styles.metric}>Argus</span>
        <span className={styles.metric}>Ready</span>
      </div>
      <div className={styles.right}>
        <button
          className={styles.toggle}
          data-active={logsOpen}
          aria-pressed={logsOpen}
          onClick={toggleLogs}
          title="Toggle activity log"
        >
          {logsOpen ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          Logs ({visibleCount})
        </button>
        <button
          className={styles.toggle}
          data-active={inspectorOpen}
          aria-pressed={inspectorOpen}
          onClick={toggleInspector}
          title="Toggle inspector (⌘\\)"
        >
          <PanelRight size={12} />
          Inspector
        </button>
      </div>
    </div>
  );
}
