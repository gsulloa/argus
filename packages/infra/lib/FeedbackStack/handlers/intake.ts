/**
 * Feedback intake Lambda handler.
 *
 * POST /feedback  →  app-key auth  →  validate payload  →  PutItem  →  presigned PUT URLs
 *
 * Request body (JSON):
 * {
 *   message: string,               // required
 *   category?: "bug" | "idea" | "other",
 *   email?: string,
 *   metadata: {
 *     appVersion: string,          // required; extra keys preserved as-is
 *     os?, osVersion?, arch?, locale?, activeEngineType?: string,
 *   },
 *   attachments?: Array<{
 *     filename: string,
 *     contentType: string,
 *     size: number,                // bytes
 *   }>,
 * }
 *
 * Response 200 (JSON):
 * {
 *   id: string,                    // ULID of the created item
 *   uploads: Array<{ filename, url, key }>,  // presigned PUT URLs (15 min TTL)
 * }
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import middy from "@middy/core";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { monotonicFactory } from "ulid";
import { z } from "zod";

import { apiResponse } from "../../shared/helpers/apiResponse";
import { loggerWithContext } from "../../shared/middleware/loggerWithContext";
import { withAppKey } from "../../shared/middleware/withAppKey";
import { withErrorHandler } from "../../shared/middleware/withErrorHandler";
import {
  withEventSchema,
  type ValidatedEvent,
} from "../../shared/middleware/withEventSchema";

// ── Env (validated at cold start; fails fast on misconfiguration) ─────────────
const Env = z.object({
  TABLE_NAME: z.string().min(1),
  BUCKET_NAME: z.string().min(1),
  APP_KEY_SSM_PATH: z.string().min(1),
  MAX_MESSAGE_CHARS: z.coerce.number().int().positive().default(5000),
  MAX_ATTACHMENTS: z.coerce.number().int().positive().default(3),
  MAX_ATTACHMENT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
});
const env = Env.parse(process.env);

const APP_KEY_HEADER = "x-argus-feedback-key";

// ── Payload schema ────────────────────────────────────────────────────────────
const attachmentSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  size: z.number().int().positive().max(env.MAX_ATTACHMENT_BYTES),
});

const bodySchema = z.object({
  message: z.string().trim().min(1).max(env.MAX_MESSAGE_CHARS),
  category: z.enum(["bug", "idea", "other"]).optional(),
  email: z.string().trim().min(1).optional(),
  // Required `appVersion`; any additional metadata keys are kept verbatim.
  metadata: z.looseObject({ appVersion: z.string().min(1) }),
  attachments: z.array(attachmentSchema).max(env.MAX_ATTACHMENTS).optional(),
});

type FeedbackBody = z.infer<typeof bodySchema>;

// ── AWS clients ───────────────────────────────────────────────────────────────
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});
const ulid = monotonicFactory();

// ── Handler: pure business logic; input is already authed and validated ───────
const baseHandler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  const body = (event as ValidatedEvent<FeedbackBody>).validatedBody;

  const id = ulid();
  const createdAt = new Date().toISOString();

  // Stable S3 keys for each declared attachment.
  const attachments = body.attachments ?? [];
  const attachmentKeys = attachments.map((att, idx) => {
    const ext = att.filename.includes(".")
      ? att.filename.split(".").pop()!
      : "bin";
    return `attachments/${id}/${idx}.${ext}`;
  });

  const item: Record<string, unknown> = {
    pk: "FEEDBACK",
    sk: id,
    createdAt,
    status: "new",
    message: body.message.trim(),
    metadata: body.metadata,
    attachments: attachmentKeys,
    ...(body.category ? { category: body.category } : {}),
    ...(body.email ? { email: body.email } : {}),
  };

  await dynamo.send(new PutCommand({ TableName: env.TABLE_NAME, Item: item }));

  const uploads = await Promise.all(
    attachments.map(async (att, idx) => {
      const key = attachmentKeys[idx]!;
      const command = new PutObjectCommand({
        Bucket: env.BUCKET_NAME,
        Key: key,
        ContentType: att.contentType,
        ContentLength: att.size,
      });
      const url = await getSignedUrl(s3, command, { expiresIn: 900 }); // 15 min
      return { filename: att.filename, url, key };
    })
  );

  return apiResponse(200, { id, uploads });
};

export const handler = middy<
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2
>(baseHandler)
  .use(loggerWithContext())
  .use(withErrorHandler())
  .use(withAppKey({ ssmPath: env.APP_KEY_SSM_PATH, header: APP_KEY_HEADER }))
  .use(withEventSchema(bodySchema));
