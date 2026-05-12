import type { AppError } from "@/platform/errors/AppError";

export const DYNAMO_KIND = "dynamodb" as const;

export type DynamoAuth = "access_keys" | "profile";

export interface DynamoParams {
  auth: DynamoAuth;
  profile?: string;
  region: string;
  endpoint_url?: string;
  read_only: boolean;
  needs_credentials?: boolean;
}

export interface AwsCredentials {
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
}

export interface ProfileInfo {
  name: string;
  sso: boolean;
  region?: string;
}

export interface ActiveDynamoConnection {
  id: string;
  account_id: string;
  identity_arn: string;
  region: string;
  read_only: boolean;
  connected_at_unix_ms: number;
}

export type TestConnectionResult =
  | { ok: true; latencyMs: number; accountId: string; identityArn: string; region: string }
  | { ok: false; error: AppError };

export interface ConnectResult {
  accountId: string;
  identityArn: string;
  region: string;
  readOnly: boolean;
}

export interface UpdateCredentialsInput {
  aws_access_key_id: string;
  aws_secret_access_key: string;
  aws_session_token?: string;
}
