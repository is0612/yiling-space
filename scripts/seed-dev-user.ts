import "dotenv/config";
import { randomBytes, scryptSync } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const connectionString = process.env.DATABASE_URL;
const ownerId = process.env.DEV_OWNER_ID;
const username = process.env.DEV_OWNER_USERNAME || "local-dev";
const password = process.env.DEV_OWNER_PASSWORD;
// 下限只拦明显不安全的占位密码。网页端「修改密码」另有更严格的策略（server/utils/auth.ts 的
// MIN_PASSWORD_LENGTH），两边故意不同：种子脚本只服务于本机开发账号，不跟着界面策略一起收紧。
const MIN_SEED_PASSWORD_LENGTH = 8;

if (!connectionString) throw new Error("缺少 DATABASE_URL，请先配置 .env。");
if (!ownerId) throw new Error("缺少 DEV_OWNER_ID，请先配置 .env。");
if (!password || password.startsWith("replace_with_") || password.length < MIN_SEED_PASSWORD_LENGTH) {
  throw new Error(`请将 DEV_OWNER_PASSWORD 设置为至少 ${MIN_SEED_PASSWORD_LENGTH} 位的本地开发密码。`);
}

const salt = randomBytes(16);
const passwordHash = `scrypt$${salt.toString("base64url")}$${scryptSync(password, salt, 64).toString("base64url")}`;
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

try {
  const user = await prisma.user.upsert({
    where: { id: ownerId },
    create: {
      id: ownerId,
      username,
      passwordHash,
      displayName: "系统管理员",
      role: "ADMIN",
    },
    update: {
      username,
      passwordHash,
      displayName: "系统管理员",
      role: "ADMIN",
    },
    select: { id: true, username: true, role: true },
  });

  console.log(`本地开发管理员已准备：${user.username} (${user.id}, ${user.role})`);
  console.log("可使用该用户名和 DEV_OWNER_PASSWORD 在网页登录；本地开发默认仍允许 localhost 免登录回退。");
} finally {
  await prisma.$disconnect();
}
