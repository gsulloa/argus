import { ArrowRight } from "lucide-react";
import styles from "./ResultPanel.module.css";

interface Props {
  message: string;
  code: string | null;
  position: number | null;
  /** When the failure came from a multi-statement, label as `Statement N`. */
  statementIndex?: number;
  /** Called with the absolute editor offset to move the cursor to. */
  onShowInEditor?(offset: number): void;
  /** Statement's `startOffset` in the editor, used to compute the absolute offset. */
  statementStartOffset?: number;
}

export function ResultErrorBlock({
  message,
  code,
  position,
  statementIndex,
  onShowInEditor,
  statementStartOffset = 0,
}: Props) {
  const targetOffset =
    position !== null ? statementStartOffset + Math.max(0, position - 1) : null;
  return (
    <div className={styles.errorBlock} role="alert">
      <div className={styles.errorHeader}>
        {statementIndex !== undefined ? (
          <span className={styles.errorPrefix}>Statement {statementIndex + 1}</span>
        ) : null}
        {code ? <span className={styles.sqlstate}>{code}</span> : null}
      </div>
      <div className={styles.errorMessage}>{message}</div>
      {targetOffset !== null && onShowInEditor ? (
        <button
          type="button"
          className={styles.showInEditor}
          onClick={() => onShowInEditor(targetOffset)}
        >
          <ArrowRight size={11} />
          Show in editor
          <span className={styles.errorPosition}>at {position}</span>
        </button>
      ) : null}
    </div>
  );
}
