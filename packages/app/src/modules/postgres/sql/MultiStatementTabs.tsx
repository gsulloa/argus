import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { RunManyOutcome } from "./api";
import styles from "./ResultPanel.module.css";

interface Props {
  outcomes: RunManyOutcome[];
  renderTab(outcome: RunManyOutcome): ReactNode;
}

function labelFor(o: RunManyOutcome): string {
  const idx = o.statement_index + 1;
  if (o.status === "ok") {
    if (o.result.kind === "rows") {
      const trunc = o.result.truncated ? "+" : "";
      return `${idx} · ${o.result.rows.length}${trunc} rows`;
    }
    return `${idx} · ${o.result.command_tag}`;
  }
  if (o.status === "err") {
    return `${idx} · ✗ ${o.error.code ?? "error"}`;
  }
  return `${idx} · … skipped`;
}

export function MultiStatementTabs({ outcomes, renderTab }: Props) {
  const firstFailure = outcomes.findIndex((o) => o.status === "err");
  const initial = firstFailure >= 0 ? firstFailure : 0;
  const [active, setActive] = useState(initial);
  // Reset active tab when outcomes shape changes (different run).
  useEffect(() => {
    setActive(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcomes]);

  if (outcomes.length === 0) return null;
  const current = outcomes[active] ?? outcomes[0]!;

  return (
    <div className={styles.multiRoot}>
      <div className={styles.multiTabs} role="tablist">
        {outcomes.map((o, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={i === active}
            className={`${styles.multiTab} ${i === active ? styles.multiTabActive : ""} ${
              o.status === "err" ? styles.multiTabErr : ""
            } ${o.status === "skipped" ? styles.multiTabSkipped : ""}`}
            onClick={() => setActive(i)}
          >
            {labelFor(o)}
          </button>
        ))}
      </div>
      <div className={styles.multiBody}>{renderTab(current)}</div>
    </div>
  );
}
