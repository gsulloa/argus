import { useContextObject } from "@/modules/context/hooks";
import styles from "./DocsSubtab.module.css";

export interface DocsSubtabProps {
  connectionId: string;
  contextPath: string | null;
  identity: string; // e.g. "public.users"
}

export function DocsSubtab({
  connectionId,
  contextPath,
  identity,
}: DocsSubtabProps): JSX.Element {
  const { data, loading, error } = useContextObject(connectionId, identity, contextPath);

  if (loading && data === null) {
    return (
      <div className={styles.root}>
        <div className={styles.loading}>Loading docs…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.root}>
        <div className={styles.error} role="alert">
          {error.message}
        </div>
      </div>
    );
  }

  if (data === null) {
    return (
      <div className={styles.root}>
        <div className={styles.empty}>No documentation found for this object.</div>
      </div>
    );
  }

  const tags = data.human.tags ?? [];
  const owners = data.human.owners ?? [];
  const chips = [...tags.map((t) => ({ label: t, kind: "tag" as const })), ...owners.map((o) => ({ label: o, kind: "owner" as const }))];

  return (
    <div className={styles.root}>
      {data.system.deleted_in_db && (
        <div className={styles.deletedBanner} role="alert">
          No DB match — this object is documented but no longer exists in the database.
        </div>
      )}
      <div className={styles.body}>
        {/* TODO: render as Markdown when a renderer is added to the project */}
        <pre className={styles.bodyPre}>{data.body}</pre>
      </div>
      {chips.length > 0 && (
        <div className={styles.chips}>
          {chips.map((chip, i) => (
            <span key={i} className={styles.chip} data-kind={chip.kind}>
              {chip.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
