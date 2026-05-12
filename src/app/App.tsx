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
import { ConnectionGroupsProvider } from "@/platform/connection-registry/useConnectionGroups";
import { ActivityLogProvider } from "@/platform/activity-log/store";
import { ActivityLogPanel } from "@/platform/activity-log/ActivityLogPanel";
import { UpdaterProvider } from "@/platform/updater";
import { ToastProvider } from "@/platform/toast";
import { PostgresFormProvider, usePostgresCommands } from "@/modules/postgres";
import {
  DynamoFormProvider,
  CredentialsRefreshedListener,
  useDynamoCommands,
} from "@/modules/dynamo";
import { useDataViewLifecycle } from "@/modules/dynamo/data-view/useDataViewLifecycle";
import { DynamoTablesCacheProvider, useDynamoTablesPaletteCommands } from "@/modules/dynamo/tables";
import { KindPickerProvider } from "@/platform/shell/useKindPicker";
import { useQueryHistoryCommands } from "@/modules/query-history";
import { savedQueriesStore } from "@/modules/saved-queries/store";

export function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <UpdaterProvider>
          <PaletteProvider>
            <TabsProvider>
              <ConnectionGroupsProvider>
                <ConnectionsProvider>
                  <ActivityLogProvider>
                    <PostgresFormProvider>
                      <DynamoFormProvider>
                        <DynamoTablesCacheProvider>
                          <KindPickerProvider>
                            <Shell />
                            <CredentialsRefreshedListener />
                          </KindPickerProvider>
                        </DynamoTablesCacheProvider>
                      </DynamoFormProvider>
                    </PostgresFormProvider>
                  </ActivityLogProvider>
                </ConnectionsProvider>
              </ConnectionGroupsProvider>
            </TabsProvider>
          </PaletteProvider>
        </UpdaterProvider>
      </ToastProvider>
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
      <DynamoCommands />
      <DynamoDataViewLifecycle />
      <DynamoTablesPaletteCommands />
      <QueryHistoryCommands />
      <SavedQueriesBootstrap />
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

function DynamoCommands() {
  useDynamoCommands();
  return null;
}

function DynamoDataViewLifecycle() {
  useDataViewLifecycle();
  return null;
}

function DynamoTablesPaletteCommands() {
  useDynamoTablesPaletteCommands();
  return null;
}

function QueryHistoryCommands() {
  useQueryHistoryCommands();
  return null;
}

function SavedQueriesBootstrap() {
  useEffect(() => {
    void savedQueriesStore.loadAll();
  }, []);
  return null;
}

function ShortcutBindings() {
  const palette = usePalette();
  const tablePalette = useTablePalette();
  const { close, activeTabId, cycle, open } = useTabs();
  const { toggleInspector } = useLayout();

  useCommandHotkeys();

  useShortcuts([
    { key: "k", whenInInput: true, handler: () => palette.show() },
    { key: "p", shift: true, whenInInput: true, handler: () => palette.show() },
    { key: "p", whenInInput: true, handler: () => tablePalette.show() },
    {
      key: "w",
      whenInInput: true,
      handler: () => {
        if (activeTabId) close(activeTabId);
      },
    },
    { key: "\\", whenInInput: true, handler: toggleInspector },
    {
      key: ",",
      whenInInput: true,
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
