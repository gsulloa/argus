/**
 * FormWindowSurface — full-window panel that replaces Radix Dialog chrome.
 *
 * Used by the connection-form and feedback windows, which are dedicated
 * native Tauri windows (no overlay, no portal, no focus-trap needed).
 * The form still renders its own Cancel/Save buttons in a footer.
 *
 * Follows DESIGN.md: Geist font, single accent violet, hairline borders,
 * compact spacing, --radius-md corners, no decorative gradients.
 */

import type { ReactNode } from "react";
import styles from "./FormWindowSurface.module.css";

export interface FormWindowSurfaceProps {
  title: string;
  description?: string;
  children: ReactNode;
}

export function FormWindowSurface({ title, description, children }: FormWindowSurfaceProps) {
  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <h1 className={styles.title}>{title}</h1>
        {description && <p className={styles.description}>{description}</p>}
      </header>
      <div className={styles.body}>{children}</div>
    </div>
  );
}
