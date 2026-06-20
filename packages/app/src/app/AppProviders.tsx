import { type ReactNode } from "react";
import { ThemeProvider } from "@/platform/shell/ThemeProvider";
import { ToastProvider } from "@/platform/toast";
import { UpdaterProvider } from "@/platform/updater";
import { PaletteProvider } from "@/platform/command-palette";
import { TabsProvider } from "@/platform/shell/tabs";
import { FocusedConnectionProvider } from "@/platform/shell/FocusedConnectionContext";
import { ConnectionGroupsProvider } from "@/platform/connection-registry/useConnectionGroups";
import { ConnectionsProvider } from "@/platform/connection-registry/useConnections";
import { AiSettingsProvider } from "@/modules/ai/store";
import { ContextEventBusProvider } from "@/modules/context/eventBus";
import { ActivityLogProvider } from "@/platform/activity-log/store";
import { PostgresFormProvider } from "@/modules/postgres";
import { MysqlFormProvider } from "@/modules/mysql";
import { MssqlFormProvider } from "@/modules/mssql";
import { DynamoFormProvider, CredentialsRefreshedListener } from "@/modules/dynamo";
import { AthenaFormProvider } from "@/modules/athena";
import { CloudwatchFormProvider } from "@/modules/cloudwatch";
import { DynamoTablesCacheProvider } from "@/modules/dynamo/tables";
import { KindPickerProvider } from "@/platform/shell/useKindPicker";

/**
 * Full provider pyramid shared by both the Manager and Workspace windows.
 * Both windows use all providers — including unused ones — to keep the two
 * windows in a consistent, predictable state. Provider overhead is negligible.
 *
 * The only thing that differs between windows is the SHELL rendered as children.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <ToastProvider>
        <UpdaterProvider>
          <PaletteProvider>
            <FocusedConnectionProvider>
            <TabsProvider>
              <ConnectionGroupsProvider>
                <ConnectionsProvider>
                  <AiSettingsProvider>
                  <ContextEventBusProvider>
                  <ActivityLogProvider>
                    <PostgresFormProvider>
                      <MysqlFormProvider>
                        <MssqlFormProvider>
                          <DynamoFormProvider>
                            <AthenaFormProvider>
                              <CloudwatchFormProvider>
                                <DynamoTablesCacheProvider>
                                  <KindPickerProvider>
                                    {children}
                                    <CredentialsRefreshedListener />
                                  </KindPickerProvider>
                                </DynamoTablesCacheProvider>
                              </CloudwatchFormProvider>
                            </AthenaFormProvider>
                          </DynamoFormProvider>
                        </MssqlFormProvider>
                      </MysqlFormProvider>
                    </PostgresFormProvider>
                  </ActivityLogProvider>
                  </ContextEventBusProvider>
                  </AiSettingsProvider>
                </ConnectionsProvider>
              </ConnectionGroupsProvider>
            </TabsProvider>
            </FocusedConnectionProvider>
          </PaletteProvider>
        </UpdaterProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
