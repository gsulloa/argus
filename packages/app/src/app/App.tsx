import { useEffect } from "react";
import { useTheme } from "@/platform/shell/ThemeProvider";
import { Layout } from "@/platform/shell/Layout";
import { Sidebar } from "@/platform/shell/Sidebar";
import { Inspector } from "@/platform/shell/Inspector";
import { StatusBar } from "@/platform/shell/StatusBar";
import {
  TabContent,
  TabStrip,
  useTabs,
  SETTINGS_PLACEHOLDER_KIND,
  SETTINGS_PLACEHOLDER_TAB_ID,
} from "@/platform/shell/tabs";
import { useFocusedConnection } from "@/platform/shell/FocusedConnectionContext";
import { useShortcuts } from "@/platform/shell/useShortcuts";
import { useLayout } from "@/platform/shell/Layout";
import {
  CommandRegistry,
  Palette,
  TablePalette,
  useCommandHotkeys,
  usePalette,
  useTablePalette,
} from "@/platform/command-palette";
import { AiSettingsHost } from "@/modules/ai/AiSettingsHost";
import { FeedbackHost } from "@/platform/feedback";
import { ActivityLogPanel } from "@/platform/activity-log/ActivityLogPanel";
import { usePostgresCommands } from "@/modules/postgres";
import { useDynamoCommands } from "@/modules/dynamo";
import { useMysqlCommands } from "@/modules/mysql";
import { useMysqlTabLifecycle } from "@/modules/mysql/useMysqlTabLifecycle";
import { useMssqlCommands } from "@/modules/mssql";
import { useMssqlTabLifecycle } from "@/modules/mssql/useMssqlTabLifecycle";
import { useDataViewLifecycle } from "@/modules/dynamo/data-view/useDataViewLifecycle";
import { useDynamoTablesPaletteCommands } from "@/modules/dynamo/tables";
import { useQueryHistoryCommands } from "@/modules/query-history";
import { savedQueriesStore } from "@/modules/saved-queries/store";
import { AppProviders } from "./AppProviders";

export function App() {
  return (
    <AppProviders>
      <Shell />
    </AppProviders>
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

export function ShellMain() {
  return (
    <>
      <ShortcutBindings />
      <DevCommands />
      <PostgresCommands />
      <MysqlCommands />
      <MysqlTabLifecycle />
      <MssqlCommands />
      <MssqlTabLifecycle />
      <DynamoCommands />
      <DynamoDataViewLifecycle />
      <DynamoTablesPaletteCommands />
      <QueryHistoryCommands />
      <AiSettingsHost />
      <FeedbackHost />
      <SavedQueriesBootstrap />
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

function MysqlCommands() {
  useMysqlCommands();
  return null;
}

function MysqlTabLifecycle() {
  useMysqlTabLifecycle();
  return null;
}

function MssqlCommands() {
  useMssqlCommands();
  return null;
}

function MssqlTabLifecycle() {
  useMssqlTabLifecycle();
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
  const { focusedConnectionId } = useFocusedConnection();
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
      // Settings tab opens in the focused connection's set.
      // If no connection is focused, ⌘, is a no-op in the Workspace (task 5.6).
      handler: () => {
        if (!focusedConnectionId) return;
        open({
          id: SETTINGS_PLACEHOLDER_TAB_ID,
          kind: SETTINGS_PLACEHOLDER_KIND,
          title: "Settings",
          payload: null,
        });
      },
    },
    { key: "Tab", mod: false, handler: () => cycle(1) },
    { key: "Tab", mod: false, shift: true, handler: () => cycle(-1) },
  ]);

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
