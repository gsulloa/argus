import { Request } from "@middy/core";
import { z, ZodError } from "zod";

import { apiResponse } from "../apiResponse";
import { logger } from "../logger";

interface WithEventSchemaParams<T extends z.ZodType<any, any, any>> {
  schema: T;
  exposeErrorApi?: boolean;
}
export const withEventSchema = <T extends z.ZodType<any, any, any>>(
  params: WithEventSchemaParams<T>
) => {
  const { schema } = params;
  return {
    before: (request: { event: z.infer<typeof schema> }) => {
      const { event } = request;
      const { data, error } = schema.safeParse(event);
      if (error) {
        throw error;
      }
      request.event = data;
    },
    onError: (request: Request<unknown, unknown, Error>) => {
      const { error } = request;
      logger.info({ message: "onError", error });
      if (error instanceof ZodError && !!params.exposeErrorApi) {
        request.response = apiResponse({
          statusCode: 400,
          body: {
            message: "Invalid request body",
            errors: error.issues,
          },
        });
        return request.response;
      }
      return undefined;
    },
  };
};
