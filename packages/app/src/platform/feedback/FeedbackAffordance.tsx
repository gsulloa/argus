/**
 * FeedbackAffordance — subtle persistent button in the app shell.
 *
 * Placed next to the VersionIndicator in StatusBar. Styled to match the
 * existing status-bar toggle buttons: 11px text, --text-subtle color,
 * transparent background, subtle hover.
 */

import { MessageSquare } from "lucide-react";
import { useFeedback } from "./FeedbackHost";
import styles from "./FeedbackDialog.module.css";

export function FeedbackAffordance() {
  const { show } = useFeedback();
  return (
    <button
      type="button"
      className={styles.affordanceBtn}
      onClick={show}
      title="Send feedback"
      aria-label="Send feedback"
    >
      <MessageSquare size={11} strokeWidth={1.6} aria-hidden="true" />
      Feedback
    </button>
  );
}
