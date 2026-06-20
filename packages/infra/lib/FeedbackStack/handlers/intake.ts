/**
 * Feedback intake Lambda handler.
 *
 * POST /feedback  →  validate app-key + payload  →  PutItem  →  presigned PUT URLs
 *
 * Request body (JSON):
 * {
 *   message: string,               // required
 *   category?: "bug" | "idea" | "other",
 *   email?: string,
 *   metadata: {
 *     appVersion: string,
 *     os: string,
 *     osVersion: string,
 *     arch: string,
 *     locale: string,
 *     activeEngineType?: string,
 *   },
 *   attachments?: Array<{
 *     filename: string,
 *     contentType: string,
 *     size: number,            // bytes
 *   }>,
 * }
 *
 * Response 200 (JSON):
 * {
 *   id: string,                    // ULID of the created item
 *   uploads: Array<{
 *     filename: string,
 *     url: string,                 // presigned PUT URL (15 min TTL)
 *     key: string,                 // S3 object key
 *   }>,
 * }
 *
 * Error responses:
 *   401  { error: "Unauthorized" }
 *   400  { error: string }
 *   500  { error: "Internal server error" }
 */

import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { monotonicFactory } from "ulid";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

// ── Env vars injected by NodejsFunctionBuilder ───────────────────────────────
const TABLE_NAME = process.env["TABLE_NAME"]!;
const BUCKET_NAME = process.env["BUCKET_NAME"]!;
const APP_KEY_SSM_PATH = process.env["APP_KEY_SSM_PATH"]!;

// ── Caps (injected at build time from constants) ─────────────────────────────
const MAX_MESSAGE_CHARS = Number(process.env["MAX_MESSAGE_CHARS"] ?? "5000");
const MAX_ATTACHMENTS = Number(process.env["MAX_ATTACHMENTS"] ?? "3");
const MAX_ATTACHMENT_BYTES = Number(process.env["MAX_ATTACHMENT_BYTES"] ?? String(5 * 1024 * 1024));

// ── AWS clients ───────────────────────────────────────────────────────────────
const ssm = new SSMClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});
const ulid = monotonicFactory();

// ── App-key cache (survive warm invocations, re-fetch on mismatch) ────────────
let cachedAppKey: string | null = null;

async function getAppKey(): Promise<string> {
  if (cachedAppKey !== null) return cachedAppKey;
  const res = await ssm.send(
    new GetParameterCommand({ Name: APP_KEY_SSM_PATH, WithDecryption: true })
  );
  cachedAppKey = res.Parameter?.Value ?? "";
  return cachedAppKey;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

const VALID_CATEGORIES = new Set(["bug", "idea", "other"]);

// ── Handler ───────────────────────────────────────────────────────────────────
export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  try {
    // ── App-key check (case-insensitive header lookup) ────────────────────────
    const headers = event.headers ?? {};
    const providedKey =
      headers["x-argus-feedback-key"] ??
      headers["X-Argus-Feedback-Key"] ??
      // HTTP API v2 lowercases headers — cover both for safety.
      Object.entries(headers).find(
        ([k]) => k.toLowerCase() === "x-argus-feedback-key"
      )?.[1];

    const expectedKey = await getAppKey();

    if (!providedKey || providedKey !== expectedKey) {
      // Invalidate cache so rotation takes effect on next request.
      cachedAppKey = null;
      return json(401, { error: "Unauthorized" });
    }

    // ── Parse body ────────────────────────────────────────────────────────────
    let body: unknown;
    try {
      body = JSON.parse(event.body ?? "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    if (typeof body !== "object" || body === null) {
      return json(400, { error: "Body must be a JSON object" });
    }

    const req = body as Record<string, unknown>;

    // ── Validate message ─────────────────────────────────────────────────────
    const message = req["message"];
    if (typeof message !== "string" || message.trim().length === 0) {
      return json(400, { error: "message is required and must be non-empty" });
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return json(400, {
        error: `message exceeds maximum length of ${MAX_MESSAGE_CHARS} characters`,
      });
    }

    // ── Validate category (optional) ─────────────────────────────────────────
    const category = req["category"];
    if (category !== undefined && !VALID_CATEGORIES.has(category as string)) {
      return json(400, { error: "category must be one of: bug, idea, other" });
    }

    // ── Validate email (optional, basic check) ───────────────────────────────
    const email = req["email"];
    if (email !== undefined && typeof email !== "string") {
      return json(400, { error: "email must be a string" });
    }

    // ── Validate metadata ─────────────────────────────────────────────────────
    const metadata = req["metadata"];
    if (typeof metadata !== "object" || metadata === null) {
      return json(400, { error: "metadata is required and must be an object" });
    }
    const meta = metadata as Record<string, unknown>;
    if (typeof meta["appVersion"] !== "string") {
      return json(400, { error: "metadata.appVersion is required" });
    }

    // ── Validate attachments ──────────────────────────────────────────────────
    const attachmentsRaw = req["attachments"];
    const attachmentDecls: Array<{
      filename: string;
      contentType: string;
      size: number;
    }> = [];

    if (attachmentsRaw !== undefined) {
      if (!Array.isArray(attachmentsRaw)) {
        return json(400, { error: "attachments must be an array" });
      }
      if (attachmentsRaw.length > MAX_ATTACHMENTS) {
        return json(400, {
          error: `attachments exceeds maximum count of ${MAX_ATTACHMENTS}`,
        });
      }
      for (const att of attachmentsRaw) {
        if (typeof att !== "object" || att === null) {
          return json(400, { error: "each attachment must be an object" });
        }
        const a = att as Record<string, unknown>;
        if (typeof a["filename"] !== "string" || !a["filename"]) {
          return json(400, { error: "attachment.filename is required" });
        }
        if (typeof a["contentType"] !== "string" || !a["contentType"]) {
          return json(400, { error: "attachment.contentType is required" });
        }
        if (typeof a["size"] !== "number" || a["size"] <= 0) {
          return json(400, { error: "attachment.size must be a positive number" });
        }
        if ((a["size"] as number) > MAX_ATTACHMENT_BYTES) {
          return json(400, {
            error: `attachment ${a["filename"]} exceeds maximum size of ${MAX_ATTACHMENT_BYTES} bytes`,
          });
        }
        attachmentDecls.push({
          filename: a["filename"] as string,
          contentType: a["contentType"] as string,
          size: a["size"] as number,
        });
      }
    }

    // ── Generate item ULID ────────────────────────────────────────────────────
    const id = ulid();
    const createdAt = new Date().toISOString();

    // ── Build S3 keys for declared attachments ────────────────────────────────
    const attachmentKeys = attachmentDecls.map((att, idx) => {
      const ext = att.filename.includes(".")
        ? att.filename.split(".").pop()!
        : "bin";
      return `attachments/${id}/${idx}.${ext}`;
    });

    // ── PutItem to DynamoDB ───────────────────────────────────────────────────
    const item: Record<string, unknown> = {
      pk: "FEEDBACK",
      sk: id,
      createdAt,
      status: "new",
      message: message.trim(),
      metadata,
      attachments: attachmentKeys,
    };
    if (category !== undefined) item["category"] = category;
    if (email !== undefined && typeof email === "string" && email.trim()) {
      item["email"] = email.trim();
    }

    await dynamo.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

    // ── Generate presigned PUT URLs ───────────────────────────────────────────
    const uploads = await Promise.all(
      attachmentDecls.map(async (att, idx) => {
        const key = attachmentKeys[idx]!;
        const command = new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: key,
          ContentType: att.contentType,
          ContentLength: att.size,
        });
        const url = await getSignedUrl(s3, command, { expiresIn: 900 }); // 15 min
        return { filename: att.filename, url, key };
      })
    );

    return json(200, { id, uploads });
  } catch (err) {
    console.error("Unhandled error in feedback intake", err);
    return json(500, { error: "Internal server error" });
  }
};
