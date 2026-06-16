/**
 * §20.4 — MS SQL Server MultiStatementTabs.
 *
 * Renders a tab strip for multi-statement run results.
 * The active tab defaults to the first failed statement (if any).
 * Mirrors mysql/sql/MultiStatementTabs.tsx.
 */

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { StatementOutcome, RunSqlResult } from "../types";

interface Props {
  outcomes: StatementOutcome[];
  renderTab(outcome: StatementOutcome): ReactNode;
}

function labelFor(o: StatementOutcome): string {
  const idx = o.statement_index + 1;
  if (o.outcome === "ok" && o.result) {
    if (o.result.kind === "rows") {
      const trunc = o.result.truncated ? "+" : "";
      return `${idx} · ${o.result.rows.length}${trunc} rows`;
    }
    return `${idx} · ${o.result.command_tag}`;
  }
  if (o.outcome === "err") {
    const code = o.error?.code != null ? String(o.error.code) : "error";
    return `${idx} · ✗ ${code}`;
  }
  return `${idx} · … skipped`;
}

export function MultiStatementTabs({ outcomes, renderTab }: Props) {
  const firstFailure = outcomes.findIndex((o) => o.outcome === "err");
  const initial = firstFailure >= 0 ? firstFailure : 0;
  const [active, setActive] = useState(initial);

  useEffect(() => {
    setActive(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcomes]);

  if (outcomes.length === 0) return null;
  const current = outcomes[active] ?? outcomes[0]!;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          display: "flex",
          gap: 2,
          padding: "0 8px",
          borderBottom: "1px solid var(--border)",
          background: "var(--surface)",
          flexShrink: 0,
          overflowX: "auto",
        }}
        role="tablist"
      >
        {outcomes.map((o, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={i === active}
            onClick={() => setActive(i)}
            style={{
              fontSize: 11,
              padding: "4px 10px",
              border: "none",
              borderBottom: i === active ? "2px solid var(--accent)" : "2px solid transparent",
              background: "transparent",
              color:
                o.outcome === "err"
                  ? "var(--danger)"
                  : o.outcome === "skipped"
                    ? "var(--text-subtle)"
                    : i === active
                      ? "var(--text)"
                      : "var(--text-muted)",
              cursor: "pointer",
              whiteSpace: "nowrap",
              fontFamily: "var(--font-mono)",
            }}
          >
            {labelFor(o)}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>{renderTab(current)}</div>
    </div>
  );
}

export type { StatementOutcome, RunSqlResult };
