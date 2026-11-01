import { PrismaPg } from "@prisma/adapter-pg";
import { createError } from "h3";
import { PrismaClient } from "../../src/generated/prisma/client";

type GlobalWithPrisma = typeof globalThis & {
  __yilingPrisma?: PrismaClient;
};

const globalForPrisma = globalThis as GlobalWithPrisma;

export function getPrisma(): PrismaClient {
  if (globalForPrisma.__yilingPrisma) {
    return globalForPrisma.__yilingPrisma;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw createError({
      statusCode: 503,
      statusMessage: "缺少 DATABASE_URL。请先复制并配置 .env，再启动 PostgreSQL。",
    });
  }

  const adapter = new PrismaPg({ connectionString });
  const client = new PrismaClient({ adapter });
  globalForPrisma.__yilingPrisma = client;
  return client;
}
