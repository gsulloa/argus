import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import type { MiddlewareObj } from "@middy/core";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";

import { apiResponse } from "../helpers/apiResponse";

const ssm = new SSMClient({});

// Cached across warm invocations; invalidated on a mismatch so key rotation
// takes effect on the next request.
let cachedAppKey: string | null = null;

async function getAppKey(ssmPath: string): Promise<string> {
  if (cachedAppKey !== null) return cachedAppKey;
  const res = await ssm.send(
    new GetParameterCommand({ Name: ssmPath, WithDecryption: true })
  );
  cachedAppKey = res.Parameter?.Value ?? "";
  return cachedAppKey;
}

/**
 * Gate the request on a shared app key stored as an SSM SecureString. The key
 * is compared against a request header (case-insensitive); a missing or wrong
 * key short-circuits with 401 before the body is ever inspected.
 */
export const withAppKey = (params: {
  ssmPath: string;
  header: string;
}): MiddlewareObj<APIGatewayProxyEventV2, APIGatewayProxyResultV2> => ({
  before: async (request) => {
    const headerLower = params.header.toLowerCase();
    const headers = request.event.headers ?? {};
    const provided = Object.entries(headers).find(
      ([key]) => key.toLowerCase() === headerLower
    )?.[1];

    const expected = await getAppKey(params.ssmPath);

    if (!provided || provided !== expected) {
      cachedAppKey = null;
      request.response = apiResponse(401, { error: "Unauthorized" });
    }
  },
});
