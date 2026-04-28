import { PanelRight } from "lucide-react";
import { useLayout } from "./Layout";
import styles from "./StatusBar.module.css";

export function StatusBar() {
  const { inspectorOpen, toggleInspector } = useLayout();
  return (
    <div className={styles.root}>
      <div className={styles.left}>
        <span className={styles.metric}>Argus</span>
        <span className={styles.metric}>Ready</span>
      </div>
      <div className={styles.right}>
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
