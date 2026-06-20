import { invoke } from "@tauri-apps/api/core";
import { toAppError } from "@/platform/errors/AppError";
import type {
  CloudwatchActiveConnection,
  CloudwatchParams,
  GetLogEventsResponse,
  InsightsResult,
  ListLogGroupsResponse,
  ListLogStreamsResponse,
  ProfileInfo,
  TestConnectionResult,
} from "./types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

export const cloudwatchApi = {
  // ---------------------------------------------------------------------------
  // Test / connect / disconnect
  // ---------------------------------------------------------------------------

  async testConnection(
    params: CloudwatchParams,
    secret?: string,
  ): Promise<TestConnectionResult> {
    const raw = await call<unknown>("cloudwatch_test_connection", {
      params,
      secret: secret ?? null,
    });
    return raw as TestConnectionResult;
  },

  connect: (connectionId: string) =>
    call<void>("cloudwatch_connect", { connectionId }),

  disconnect: (connectionId: string) =>
    call<void>("cloudwatch_disconnect", { connectionId }),

  disconnectAll: () =>
    call<number>("cloudwatch_disconnect_all"),

  listActive: () =>
    call<CloudwatchActiveConnection[]>("cloudwatch_list_active"),

  // ---------------------------------------------------------------------------
  // Log groups
  // ---------------------------------------------------------------------------

  listLogGroups: (
    connectionId: string,
    nextToken?: string,
    limit?: number,
    namePattern?: string,
  ): Promise<ListLogGroupsResponse> =>
    call<ListLogGroupsResponse>("cloudwatch_list_log_groups", {
      connectionId,
      nextToken: nextToken ?? null,
      limit: limit ?? null,
      namePattern: namePattern ?? null,
    }),

  // ---------------------------------------------------------------------------
  // Log streams
  // ---------------------------------------------------------------------------

  listLogStreams: (
    connectionId: string,
    groupName: string,
    nextToken?: string,
    limit?: number,
  ): Promise<ListLogStreamsResponse> =>
    call<ListLogStreamsResponse>("cloudwatch_list_log_streams", {
      connectionId,
      groupName,
      nextToken: nextToken ?? null,
      limit: limit ?? null,
    }),

  // ---------------------------------------------------------------------------
  // Log events
  // ---------------------------------------------------------------------------

  getLogEvents: (
    connectionId: string,
    groupName: string,
    streamName: string,
    options?: {
      forwardToken?: string;
      backwardToken?: string;
      startFromHead?: boolean;
      limit?: number;
    },
  ): Promise<GetLogEventsResponse> =>
    call<GetLogEventsResponse>("cloudwatch_get_log_events", {
      connectionId,
      groupName,
      streamName,
      forwardToken: options?.forwardToken ?? null,
      backwardToken: options?.backwardToken ?? null,
      startFromHead: options?.startFromHead ?? null,
      limit: options?.limit ?? null,
    }),

  // ---------------------------------------------------------------------------
  // Insights
  // ---------------------------------------------------------------------------

  runInsights: (
    connectionId: string,
    logGroupIdentifiers: string[],
    startTime: number,
    endTime: number,
    queryString: string,
    limit?: number,
    origin?: "user" | "auto",
  ): Promise<InsightsResult> =>
    call<InsightsResult>("cloudwatch_run_insights", {
      connectionId,
      logGroupIdentifiers,
      startTime,
      endTime,
      queryString,
      limit: limit ?? null,
      origin: origin ?? null,
    }),

  cancelInsights: (connectionId: string, queryId: string): Promise<void> =>
    call<void>("cloudwatch_cancel_insights", { connectionId, queryId }),

  // ---------------------------------------------------------------------------
  // AWS profile listing — reuse the dynamo command (same backend function)
  // ---------------------------------------------------------------------------

  listAwsProfiles: () =>
    call<ProfileInfo[]>("dynamo_list_aws_profiles"),
};
