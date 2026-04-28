import { TabRegistry } from "./TabRegistry";
import styles from "./welcome.module.css";

export const WELCOME_KIND = "welcome";

function WelcomeTab() {
  return (
    <div className={styles.root}>
      <h1>Welcome to Argus</h1>
      <p>A desktop tool for inspecting and editing data across multiple sources.</p>
      <ul className={styles.shortcuts}>
        <li>
          <kbd>⌘K</kbd> Open command palette
        </li>
        <li>
          <kbd>⌘\</kbd> Toggle inspector
        </li>
        <li>
          <kbd>⌘W</kbd> Close active tab
        </li>
        <li>
          <kbd>⌘,</kbd> Open settings
        </li>
      </ul>
    </div>
  );
}

TabRegistry.register(WELCOME_KIND, WelcomeTab);
