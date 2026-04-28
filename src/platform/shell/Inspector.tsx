import styles from "./Inspector.module.css";

export function Inspector() {
  return (
    <div className={styles.root}>
      <header className={styles.header}>Inspector</header>
      <div className={styles.placeholder}>
        Nothing to inspect yet — open something in the center area.
      </div>
    </div>
  );
}
