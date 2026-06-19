/**
 * DocsPanel — collapsible "Docs" section for use where there is no SubtabHeader.
 *
 * Used by the Dynamo inspector (and any future flat-layout view). Thin wrapper
 * around DocsSubtab: fetches the doc via useContextObject and renders a
 * collapsible section with a "Docs" header when a doc is found.
 *
 * Renders nothing when:
 *   - contextPath is null/undefined (no folder linked)
 *   - identity is null/undefined
 *   - the object has no doc
 *
 * Defaults to open when first rendered with a doc present.
 */

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { useContextObject } from "@/modules/context/hooks";
import styles from "./DocsPanel.module.css";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DocsPanelProps {
  connectionId: string;
  contextPath: string | null | undefined;
  identity: string | null | undefined;
  /** Optional: column notes map for attribute decoration (passed through). */
  columnNotes?: Record<string, string> | null;
}

// ---------------------------------------------------------------------------
// DocsPanel
// ---------------------------------------------------------------------------

export function DocsPanel({
  connectionId,
  contextPath,
  identity,
}: DocsPanelProps): JSX.Element | null {
  const { data, loading } = useContextObject(connectionId, identity, contextPath);

  // Default open when doc present; lazy-init: only set after first load.
  const [open, setOpen] = useState(true);

  // Nothing to show: no context folder, no identity, or doc hasn't arrived yet.
  if (!contextPath || !identity) return null;
  if (!loading && data === null) return null;
  // While loading we still render nothing — keeps layout stable.
  if (loading && data === null) return null;
  if (!data) return null;

  const tags = data.human.tags ?? [];
  const owners = data.human.owners ?? [];
  const chips = [
    ...tags.map((t) => ({ label: t, kind: "tag" as const })),
    ...owners.map((o) => ({ label: o, kind: "owner" as const })),
  ];

  return (
    <div className={styles.root} data-testid="docs-panel">
      {/* Collapsible header */}
      <button
        type="button"
        className={styles.header}
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        data-testid="docs-panel-header"
      >
        <ChevronRight
          size={12}
          className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`}
        />
        <span className={styles.headerLabel}>Docs</span>
        {data.system.deleted_in_db && (
          <span className={styles.deletedBadge} title="Documented, no DB match">
            stale
          </span>
        )}
      </button>

      {/* Collapsible body */}
      {open && (
        <div className={styles.body} data-testid="docs-panel-body">
          {data.system.deleted_in_db && (
            <div className={styles.deletedBanner} role="alert">
              No DB match — documented but no longer exists in the database.
            </div>
          )}
          <pre className={styles.bodyPre}>{data.body}</pre>
          {chips.length > 0 && (
            <div className={styles.chips}>
              {chips.map((chip, i) => (
                // Index key is stable here — static list derived from the doc
                <span key={i} className={styles.chip} data-kind={chip.kind}>
                  {chip.label}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
