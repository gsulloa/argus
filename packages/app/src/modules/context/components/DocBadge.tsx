import { FileText } from "lucide-react";
import styles from "./DocBadge.module.css";

interface Props {
  /** When true, renders an attention color indicating `system.deleted_in_db`. */
  deletedInDb?: boolean;
}

export function DocBadge({ deletedInDb }: Props): JSX.Element {
  return (
    <span
      className={styles.root}
      data-deleted={deletedInDb || undefined}
      aria-label={deletedInDb ? "Documented, no DB match" : "Documented"}
      title={deletedInDb ? "Documented, no DB match" : "Documented"}
    >
      <FileText size={12} strokeWidth={1.6} />
    </span>
  );
}
