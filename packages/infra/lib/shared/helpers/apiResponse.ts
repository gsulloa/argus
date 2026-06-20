import type { APIGatewayProxyResultV2 } from "aws-lambda";

/**
 * Single source of truth for HTTP responses. Every handler and middleware
 * returns through here so status typing, JSON serialisation, and headers stay
 * consistent — responses are never assembled by hand.
 */
export function apiResponse(
  statusCode: number,
  body: unknown
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-Argus-Feedback-Key",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}
