interface ApiResponseParams {
  statusCode: number;
  body: any;
}
export function apiResponse({ statusCode, body }: ApiResponseParams) {
  return {
    statusCode,
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Allow-Headers": "*",
    },
  };
}
