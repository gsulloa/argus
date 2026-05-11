import { TabRegistry } from "./TabRegistry";
import styles from "./welcome.module.css";

export const WELCOME_KIND = "welcome";

function WelcomeTab(_props: { tab: unknown; active: boolean }) {
  return (
    <div className={styles.root}>
      <h1>Welcome to Argus</h1>
      <p>A desktop tool for inspecting and editing data across multiple sources.</p>
      <section className={styles.lore} aria-labelledby="why-argus">
        <h2 id="why-argus">Why Argus?</h2>
        <p>
          In Greek mythology, <em>Argus Panoptes</em> — &ldquo;the all-seeing&rdquo; — was the
          hundred-eyed giant whom Hera trusted to keep watch without rest. Even in sleep,
          some of his eyes stayed open; nothing passed him unseen.
        </p>
        <p>
          That is the promise of this tool: a single watchful surface over data scattered
          across many sources. Wherever it lives, Argus keeps an eye on it.
        </p>
      </section>
      <h2 className={styles.shortcutsHeading}>Shortcuts</h2>
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
