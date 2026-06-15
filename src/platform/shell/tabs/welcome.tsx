import { TabRegistry } from "./TabRegistry";
import styles from "./welcome.module.css";
import { APP_DISPLAY_NAME } from "@/platform/app-identity";
import { useConnections } from "@/platform/connection-registry/useConnections";
import type { Connection } from "@/platform/connection-registry/types";
import { useAiSettings } from "@/modules/ai/store";
import { useKindPicker } from "@/platform/shell/useKindPicker";
import { CommandRegistry } from "@/platform/command-palette/CommandRegistry";
import { usePostgresForm, POSTGRES_KIND } from "@/modules/postgres";
import { useMysqlForm, MYSQL_KIND } from "@/modules/mysql";
import { useMssqlForm, MSSQL_KIND } from "@/modules/mssql";
import { useDynamoForm, DYNAMO_KIND } from "@/modules/dynamo";

export const WELCOME_KIND = "welcome";

interface ChecklistItemView {
  key: string;
  label: string;
  hint: string;
  satisfied: boolean;
  /** When true, the item is inert: no CTA, just the locked hint. */
  locked?: boolean;
  ctaLabel?: string;
  onCta?: () => void;
}

export function WelcomeTab(_props: { tab: unknown; active: boolean }) {
  const { items } = useConnections();
  const { settings } = useAiSettings();
  const kindPicker = useKindPicker();
  const pg = usePostgresForm();
  const my = useMysqlForm();
  const ms = useMssqlForm();
  const dy = useDynamoForm();

  // 1. Derive onboarding state from the reactive stores.
  const hasConnection = items.length > 0;
  const aiConfigured =
    settings != null &&
    (settings.default_provider !== null || settings.overrides.length > 0);
  const hasContextFolder = items.some((c) => c.context_path != null);
  const allDone = hasConnection && aiConfigured && hasContextFolder;

  // 2.3 Open the edit form for a connection, dispatched by its kind. Only
  // engines with a connection form (and a ContextFolderRow) can link a folder.
  const editByKind: Record<string, ((c: Connection) => void) | undefined> = {
    [POSTGRES_KIND]: pg.openEdit,
    [MYSQL_KIND]: my.openEdit,
    [MSSQL_KIND]: ms.openEdit,
    [DYNAMO_KIND]: dy.openEdit,
  };
  const openEditByKind = (connection: Connection) => {
    editByKind[connection.kind]?.(connection);
  };

  // Target the first connection that actually supports context folders, so the
  // CTA never opens a form for an engine without one (e.g. CloudWatch) and
  // never dead-ends on a kind with no handler.
  const linkTarget = items.find((c) => editByKind[c.kind] != null);
  const checklist: ChecklistItemView[] = [
    {
      key: "connection",
      label: "Add a connection",
      hint: hasConnection
        ? "Connected"
        : "Connect a data source to start inspecting and editing.",
      satisfied: hasConnection,
      ctaLabel: "Add a connection",
      onCta: () => kindPicker.open(),
    },
    {
      key: "ai",
      label: "Configure AI",
      hint: aiConfigured
        ? "Configured"
        : "Set up an AI provider to chat about your data.",
      satisfied: aiConfigured,
      ctaLabel: "Configure providers",
      onCta: () => CommandRegistry.get("ai.configureProviders")?.run(),
    },
    {
      key: "context",
      label: "Link a context folder",
      satisfied: hasContextFolder,
      ...(hasContextFolder
        ? { hint: "Linked" }
        : linkTarget
          ? {
              hint: "Link a folder so AI can understand your schema.",
              ctaLabel: "Link context folder",
              onCta: () => openEditByKind(linkTarget),
            }
          : hasConnection
            ? {
                // A connection exists, but none supports context folders
                // (e.g. CloudWatch). No edit form to open, so stay locked.
                locked: true,
                hint: "Connect a SQL or DynamoDB source to link a folder.",
              }
            : {
                // 2.4 Locked until a connection exists.
                locked: true,
                hint: "Add a connection first.",
              }),
    },
  ];

  return (
    <div className={styles.root}>
      <h1>Welcome to {APP_DISPLAY_NAME}</h1>
      {/* The "Why Argus?" lore below is mythology-specific brand copy, not a
          mechanical substitution — rewrite it by hand on rename. See RENAMING.md. */}
      <p>A desktop tool for inspecting and editing data across multiple sources.</p>

      <section className={styles.gettingStarted} aria-labelledby="getting-started">
        <h2 id="getting-started" className={styles.sectionHeading}>
          Getting started
        </h2>
        {allDone ? (
          <div className={styles.allSet}>
            <span className={styles.checkMarkOk} aria-hidden="true">
              ✓
            </span>
            You&rsquo;re all set
          </div>
        ) : (
          <ul className={styles.checklist}>
            {checklist.map((item) => (
              <li key={item.key} className={styles.checkItem}>
                <span
                  className={item.satisfied ? styles.checkMarkOk : styles.checkMarkTodo}
                  aria-hidden="true"
                >
                  {item.satisfied ? "✓" : "○"}
                </span>
                <div className={styles.checkBody}>
                  <span className={styles.checkLabel}>{item.label}</span>
                  <span className={styles.checkHint}>{item.hint}</span>
                  {!item.satisfied && !item.locked && item.onCta && (
                    <button type="button" className={styles.checkCta} onClick={item.onCta}>
                      {item.ctaLabel}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

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
