import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import knex, { Knex } from "knex";

import { logger } from "@/utils/logger";

export const getDatabaseUrl = async () => {
  if (!process.env.MEKI_DATABASE_URL_SECRET_NAME) {
    throw new Error("MEKI_DATABASE_URL_SECRET_NAME is not defined");
  }
  const secretClient = new SecretsManagerClient({});
  const mekiDatabaseUrl = await secretClient.send(
    new GetSecretValueCommand({
      SecretId: process.env.MEKI_DATABASE_URL_SECRET_NAME,
    })
  );
  if (!mekiDatabaseUrl.SecretString) {
    throw new Error("Error getting meki database url");
  }
  return mekiDatabaseUrl.SecretString;
};

export const getRdsDatabaseUrl = async () => {
  if (!process.env.RDS_DATABASE_URL_SECRET_NAME) {
    throw new Error("RDS_DATABASE_URL_SECRET_NAME is not defined");
  }
  const secretClient = new SecretsManagerClient({});
  const rdsDatabaseUrl = await secretClient.send(
    new GetSecretValueCommand({
      SecretId: process.env.RDS_DATABASE_URL_SECRET_NAME,
    })
  );
  if (!rdsDatabaseUrl.SecretString) {
    throw new Error("Error getting RDS database url");
  }
  return rdsDatabaseUrl.SecretString;
};

let knexClientInitInstance: Knex<any, unknown[]> | null = null;
let knexClientInitPromise: Promise<Knex<any, unknown[]>> | null = null;
export const knexClientInit = async () => {
  if (knexClientInitInstance) return knexClientInitInstance;
  if (knexClientInitPromise) {
    await knexClientInitPromise;
    return knexClientInitInstance!;
  }

  knexClientInitPromise = (async () => {
    try {
      logger.info({ message: "Connecting to database..." });
      const connectionString = await getDatabaseUrl();
      logger.info({ message: "Database connection string", connectionString });
      knexClientInitInstance = knex({
        client: "pg",
        connection: {
          connectionString,
          application_name:
            process.env.AWS_LAMBDA_FUNCTION_NAME || "sandbox-lambda",
          ssl: { rejectUnauthorized: false },
        },
        pool: {
          min: 1,
          max: 10,
        },
      });
      return knexClientInitInstance;
    } finally {
      knexClientInitPromise = null;
    }
  })();

  return await knexClientInitPromise;
};

let knexRdsClientInitInstance: Knex<any, unknown[]> | null = null;
let knexRdsClientInitPromise: Promise<Knex<any, unknown[]>> | null = null;
export const knexRdsClientInit = async () => {
  if (knexRdsClientInitInstance) return knexRdsClientInitInstance;
  if (knexRdsClientInitPromise) {
    await knexRdsClientInitPromise;
    return knexRdsClientInitInstance!;
  }

  knexRdsClientInitPromise = (async () => {
    try {
      logger.info({ message: "Connecting to RDS database..." });
      const connectionString = await getRdsDatabaseUrl();
      logger.info({
        message: "RDS database connection string",
        connectionString,
      });
      knexRdsClientInitInstance = knex({
        client: "pg",
        connection: {
          connectionString,
          application_name:
            process.env.AWS_LAMBDA_FUNCTION_NAME || "sandbox-lambda",
          ssl: { rejectUnauthorized: false },
        },
        pool: {
          min: 1,
          max: 10,
        },
      });
      return knexRdsClientInitInstance;
    } finally {
      knexRdsClientInitPromise = null;
    }
  })();

  return await knexRdsClientInitPromise;
};
