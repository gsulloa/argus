import { invoke } from "@tauri-apps/api/core";
import { toAppError } from "@/platform/errors/AppError";
import type {
  ActiveDynamoConnection,
  ConnectResult,
  DynamoParams,
  ProfileInfo,
  TestConnectionResult,
  UpdateCredentialsInput,
} from "./types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

export const dynamoApi = {
  async testConnection(params: DynamoParams, secret?: string): Promise<TestConnectionResult> {
    const raw = await call<unknown>("dynamo_test_connection", {
      params,
      secret: secret ?? null,
    });
    return raw as TestConnectionResult;
  },

  connect: (connectionId: string) =>
    call<ConnectResult>("dynamo_connect", { connectionId }),

  disconnect: (connectionId: string) =>
    call<void>("dynamo_disconnect", { connectionId }),

  listActive: () => call<ActiveDynamoConnection[]>("dynamo_list_active"),

  listAwsProfiles: () => call<ProfileInfo[]>("dynamo_list_aws_profiles"),

  updateCredentials: (connectionId: string, creds: UpdateCredentialsInput) =>
    call<void>("dynamo_update_credentials", { connectionId, creds }),
};
