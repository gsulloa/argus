/**
 * ChangelogViewer — Radix Dialog showing the bundled changelog.
 *
 * Props:
 *   open            — controlled open state
 *   onOpenChange    — close/open callback
 *   currentVersion  — running app version string (e.g. "0.7.5", or "" outside Tauri)
 *   highlightSince  — if set, version blocks newer than this are tinted as "new"
 */

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { parseChangelog, semverCompare } from "./parse";
import type { ChangelogVersion, AnyToken } from "./parse";
import dialogOverlay from "@/platform/shell/Dialog.module.css";
import styles from "./ChangelogViewer.module.css";

// Import the bundled changelog as raw text (Vite ?raw — types from vite/client).
// Relative path from src/platform/changelog/ → src/generated/
import changelogRaw from "../../generated/changelog.md?raw";

// Parse once at module load — the raw string never changes at runtime.
const changelog = parseChangelog(changelogRaw);

// ---------------------------------------------------------------------------
// Inline token renderer
// ---------------------------------------------------------------------------

function renderTokens(tokens: AnyToken[]): React.ReactNode {
  return tokens.map((token, i) => {
    if (token.type === "link") {
      return (
        <a key={i} href={token.url} target="_blank" rel="noreferrer">
          {token.text}
        </a>
      );
    }
    return token.value;
  });
}

// ---------------------------------------------------------------------------
// VersionBlock
// ---------------------------------------------------------------------------

interface VersionBlockProps {
  version: ChangelogVersion;
  isCurrent: boolean;
  isNew: boolean;
}

function VersionBlock({ version, isCurrent, isNew }: VersionBlockProps) {
  const label = version.isUnreleased ? "Unreleased" : (version.version ?? "");

  const blockClass = [
    styles.versionBlock,
    isCurrent ? styles.isCurrent : "",
    isNew && !isCurrent ? styles.isNew : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Filter out empty groups (no entries)
  const groups = version.groups.filter((g) => g.entries.length > 0);

  return (
    <div className={blockClass}>
      <div className={styles.versionHeader}>
        <span className={styles.versionNumber}>{label}</span>
        {version.date && (
          <span className={styles.versionDate}>{version.date}</span>
        )}
      </div>

      {groups.map((group, gi) => (
        <div key={gi} className={styles.group}>
          {group.name.length > 0 && (
            <p className={styles.groupLabel}>{group.name}</p>
          )}
          <ul className={styles.entryList}>
            {group.entries.map((entry, ei) => (
              <li key={ei} className={styles.entryItem}>
                {renderTokens(entry.tokens)}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChangelogViewer
// ---------------------------------------------------------------------------

export interface ChangelogViewerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentVersion: string;
  highlightSince?: string | null;
}

export function ChangelogViewer({
  open,
  onOpenChange,
  currentVersion,
  highlightSince,
}: ChangelogViewerProps) {
  // Build the list of versions to display: unreleased (if it has entries) first,
  // then dated versions newest-first (file order is already newest-first).
  const displayVersions: ChangelogVersion[] = [];

  if (changelog.unreleased && changelog.unreleased.groups.some((g) => g.entries.length > 0)) {
    displayVersions.push(changelog.unreleased);
  }
  displayVersions.push(...changelog.versions);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlay.overlay} />
        <Dialog.Content className={styles.panel} aria-describedby={undefined}>
          {/* Header */}
          <div className={styles.header}>
            <div className={styles.headerLeft}>
              <Dialog.Title className={styles.title}>What&apos;s new</Dialog.Title>
              {currentVersion.length > 0 && (
                <span className={styles.versionPill} aria-label={`Version ${currentVersion}`}>
                  v{currentVersion}
                </span>
              )}
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className={styles.closeBtn}
                aria-label="Close changelog"
              >
                <X size={14} />
              </button>
            </Dialog.Close>
          </div>

          {/* Body */}
          <div className={styles.body}>
            {displayVersions.length === 0 ? (
              <p className={styles.emptyState}>No changelog available.</p>
            ) : (
              displayVersions.map((v, i) => {
                const isCurrent =
                  !v.isUnreleased &&
                  currentVersion.length > 0 &&
                  v.version === currentVersion;

                // "New since last seen": version is strictly newer than highlightSince
                const isNew =
                  !v.isUnreleased &&
                  !!highlightSince &&
                  v.version !== null &&
                  semverCompare(highlightSince, v.version) < 0;

                return (
                  <VersionBlock
                    key={v.isUnreleased ? "__unreleased__" : (v.version ?? String(i))}
                    version={v}
                    isCurrent={isCurrent}
                    isNew={isNew}
                  />
                );
              })
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
