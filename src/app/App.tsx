import { useEffect } from "react";
import { ThemeProvider, useTheme } from "@/platform/shell/ThemeProvider";
import { Layout } from "@/platform/shell/Layout";
import { Sidebar } from "@/platform/shell/Sidebar";
import { Inspector } from "@/platform/shell/Inspector";
import { StatusBar } from "@/platform/shell/StatusBar";
import {
  TabContent,
  TabStrip,
  TabsProvider,
  useTabs,
  WELCOME_KIND,
  SETTINGS_PLACEHOLDER_KIND,
  SETTINGS_PLACEHOLDER_TAB_ID,
} from "@/platform/shell/tabs";
import { useShortcuts } from "@/platform/shell/useShortcuts";
import { useLayout } from "@/platform/shell/Layout";
import {
  CommandRegistry,
  Palette,
  PaletteProvider,
  TablePalette,
  useCommandHotkeys,
  usePalette,
  useTablePalette,
} from "@/platform/command-palette";
import { ConnectionsProvider } from "@/platform/connection-registry/useConnections";
import { ActivityLogProvider } from "@/platform/activity-log/store";
import { ActivityLogPanel } from "@/platform/activity-log/ActivityLogPanel";
import { PostgresFormProvider, usePostgresCommands } from "@/modules/postgres";
import { useQueryHistoryCommands } from "@/modules/query-history";

export function App() {
  return (
    <ThemeProvider>
      <PaletteProvider>
        <TabsProvider>
          <ConnectionsProvider>
            <ActivityLogProvider>
              <PostgresFormProvider>
                <Shell />
              </PostgresFormProvider>
            </ActivityLogProvider>
          </ConnectionsProvider>
        </TabsProvider>
      </PaletteProvider>
    </ThemeProvider>
  );
}

function Shell() {
  return (
    <Layout
      sidebar={<Sidebar />}
      inspector={<Inspector />}
      statusBar={<StatusBar />}
      bottomPanel={<ActivityLogPanel />}
    >
      <ShellMain />
    </Layout>
  );
}

function ShellMain() {
  return (
    <>
      <ShortcutBindings />
      <DevCommands />
      <PostgresCommands />
      <QueryHistoryCommands />
      <BootstrapTabs />
      <TabStrip />
      <TabContent />
      <Palette />
      <TablePalette />
    </>
  );
}

function PostgresCommands() {
  usePostgresCommands();
  return null;
}

function QueryHistoryCommands() {
  useQueryHistoryCommands();
  return null;
}

function ShortcutBindings() {
  const palette = usePalette();
  const tablePalette = useTablePalette();
  const { close, activeTabId, cycle, open } = useTabs();
  const { toggleInspector } = useLayout();

  useCommandHotkeys();

  useShortcuts([
    { key: "k", handler: () => palette.show() },
    { key: "p", shift: true, handler: () => palette.show() },
    { key: "p", handler: () => tablePalette.show() },
    {
      key: "w",
      handler: () => {
        if (activeTabId) close(activeTabId);
      },
    },
    { key: "\\", handler: toggleInspector },
    {
      key: ",",
      handler: () =>
        open({
          id: SETTINGS_PLACEHOLDER_TAB_ID,
          kind: SETTINGS_PLACEHOLDER_KIND,
          title: "Settings",
          payload: null,
        }),
    },
    { key: "Tab", mod: false, handler: () => cycle(1) },
    { key: "Tab", mod: false, shift: true, handler: () => cycle(-1) },
  ]);

  return null;
}

function BootstrapTabs() {
  const { tabs, open } = useTabs();
  useEffect(() => {
    if (tabs.length === 0) {
      open({
        id: "welcome",
        kind: WELCOME_KIND,
        title: "Welcome",
        closable: true,
        payload: null,
      });
    }
    // intentionally only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function DevCommands() {
  const { resolved, mode, setMode } = useTheme();
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const unregister = CommandRegistry.register({
      id: "argus.devNoop",
      label: "Dev: no-op (palette ping)",
      group: "Developer",
      run: () => {
        console.log("[argus] devNoop fired");
      },
    });
    return unregister;
  }, []);

  // Register theme switching commands so users can flip from the palette.
  useEffect(() => {
    const unregisters = (
      [
        ["light", "Theme: Light"],
        ["dark", "Theme: Dark"],
        ["system", "Theme: System"],
      ] as const
    ).map(([m, label]) =>
      CommandRegistry.register({
        id: `argus.theme.${m}`,
        label,
        group: "Theme",
        keywords: ["appearance", "color"],
        run: () => setMode(m),
      }),
    );
    return () => unregisters.forEach((u) => u());
  }, [setMode]);

  // Suppress unused locals (resolved/mode); they're available for future use.
  void resolved;
  void mode;
  return null;
}
