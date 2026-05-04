import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Tooltip from "@radix-ui/react-tooltip";
import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useUpdater } from "@/platform/updater";
import overlayStyles from "./Dialog.module.css";
import styles from "./VersionIndicator.module.css";

const PRODUCT_NAME = "Argus Beta";
const IDENTIFIER = "com.argus.beta.app";
const BUILD_COMMIT = (import.meta.env.VITE_BUILD_COMMIT ?? "") as string;

export interface VersionIndicatorViewProps {
  currentVersion: string;
  pendingVersion: string | null;
  availableVersion: string | null;
  skippedVersion: string | null;
  onForceCheck: () => void;
  onSkip: () => void;
  onClearSkip: () => void;
}

export function VersionIndicatorView(props: VersionIndicatorViewProps) {
  const {
    currentVersion,
    pendingVersion,
    availableVersion,
    skippedVersion,
    onForceCheck,
    onSkip,
    onClearSkip,
  } = props;
  const [aboutOpen, setAboutOpen] = useState(false);

  if (!currentVersion) return null;

  const tooltipText = pendingVersion
    ? `Restart ${PRODUCT_NAME} to apply v${pendingVersion}`
    : `${PRODUCT_NAME} v${currentVersion}`;

  const skipTarget = pendingVersion ?? availableVersion;
  const canSkip = skipTarget !== null;
  const canClearSkip = skippedVersion !== null;

  return (
    <>
      <Tooltip.Provider delayDuration={400}>
        <DropdownMenu.Root>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <DropdownMenu.Trigger asChild>
                <button
                  className={styles.trigger}
                  aria-label={tooltipText}
                  data-pending={pendingVersion ? "true" : "false"}
                >
                  <span className={styles.current}>v{currentVersion}</span>
                  {pendingVersion && (
                    <>
                      <span className={styles.arrow} aria-hidden="true">
                        →
                      </span>
                      <span className={styles.pending}>v{pendingVersion}</span>
                    </>
                  )}
                </button>
              </DropdownMenu.Trigger>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content className={styles.tooltip} side="top" sideOffset={6}>
                {tooltipText}
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className={styles.menu}
              align="end"
              side="top"
              sideOffset={6}
              onCloseAutoFocus={(e) => e.preventDefault()}
            >
              <DropdownMenu.Item className={styles.item} onSelect={() => onForceCheck()}>
                Check for updates now
              </DropdownMenu.Item>
              {canSkip && (
                <DropdownMenu.Item className={styles.item} onSelect={() => onSkip()}>
                  Skip v{skipTarget}
                </DropdownMenu.Item>
              )}
              {canClearSkip && (
                <DropdownMenu.Item className={styles.item} onSelect={() => onClearSkip()}>
                  Clear skipped version (v{skippedVersion})
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Separator className={styles.separator} />
              <DropdownMenu.Item
                className={styles.item}
                onSelect={() => setAboutOpen(true)}
              >
                About {PRODUCT_NAME}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </Tooltip.Provider>

      <Dialog.Root open={aboutOpen} onOpenChange={setAboutOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className={overlayStyles.overlay} />
          <Dialog.Content className={overlayStyles.content}>
            <Dialog.Title className={overlayStyles.title}>About {PRODUCT_NAME}</Dialog.Title>
            <Dialog.Description className={overlayStyles.description}>
              Desktop tool for inspecting and editing data across multiple sources.
            </Dialog.Description>
            <dl className={styles.aboutList}>
              <div className={styles.aboutRow}>
                <dt>Version</dt>
                <dd>v{currentVersion}</dd>
              </div>
              {pendingVersion && (
                <div className={styles.aboutRow}>
                  <dt>Pending</dt>
                  <dd>v{pendingVersion} (restart to apply)</dd>
                </div>
              )}
              {skippedVersion && (
                <div className={styles.aboutRow}>
                  <dt>Skipped</dt>
                  <dd>v{skippedVersion}</dd>
                </div>
              )}
              <div className={styles.aboutRow}>
                <dt>Identifier</dt>
                <dd>{IDENTIFIER}</dd>
              </div>
              {BUILD_COMMIT && (
                <div className={styles.aboutRow}>
                  <dt>Build</dt>
                  <dd className={styles.mono}>{BUILD_COMMIT.slice(0, 12)}</dd>
                </div>
              )}
            </dl>
            <div className={overlayStyles.footer}>
              <button className={overlayStyles.primary} onClick={() => setAboutOpen(false)}>
                Close
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

export function VersionIndicator() {
  const ctx = useUpdater();
  return (
    <VersionIndicatorView
      currentVersion={ctx.currentVersion}
      pendingVersion={ctx.pendingVersion}
      availableVersion={ctx.availableVersion}
      skippedVersion={ctx.skippedVersion}
      onForceCheck={() => {
        void ctx.forceCheck();
      }}
      onSkip={() => ctx.skipPending()}
      onClearSkip={() => ctx.clearSkip()}
    />
  );
}
