import { TabRegistry } from "./TabRegistry";

export const SETTINGS_PLACEHOLDER_KIND = "settings-placeholder";
export const SETTINGS_PLACEHOLDER_TAB_ID = "settings-placeholder";

function SettingsPlaceholderTab(_props: { tab: unknown; active: boolean }) {
  return (
    <div style={{ padding: 32, color: "var(--text-muted)", fontSize: 13 }}>
      Settings UI ships in a follow-up change.
    </div>
  );
}

TabRegistry.register(SETTINGS_PLACEHOLDER_KIND, SettingsPlaceholderTab);
