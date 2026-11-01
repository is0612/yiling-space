import "dotenv/config";
import { getPrisma } from "../server/utils/prisma";

const prisma = getPrisma();

const rows = await prisma.$queryRaw<Array<{
  conversationId: string;
  externalId: string | null;
  title: string | null;
  speakers: bigint;
  total: bigint;
}>>`
  SELECT m."conversationId",
         c."externalConversationId" AS "externalId",
         c.title,
         COUNT(DISTINCT m.metadata->>'authorOpenId') AS speakers,
         COUNT(*) AS total
  FROM messages m
  JOIN conversations c ON c.id = m."conversationId"
  WHERE m.role = 'USER'
    AND m.metadata->>'source' = 'channel'
    AND c."channelBindingId" IS NOT NULL
  GROUP BY 1, 2, 3
  ORDER BY total DESC
`;
for (const row of rows) {
  console.log(`${row.externalId ?? "-"}\t${row.title ?? "-"}\t发言人 ${row.speakers}\t消息 ${row.total}`);
}

const sample = await prisma.$queryRaw<Array<{ openId: string | null; name: string | null; n: bigint }>>`
  SELECT m.metadata->>'authorOpenId' AS "openId",
         m.metadata->>'authorDisplayName' AS name,
         COUNT(*) AS n
  FROM messages m
  JOIN conversations c ON c.id = m."conversationId"
  WHERE m.role = 'USER' AND m.metadata->>'source' = 'channel' AND c."externalConversationId" LIKE 'g:%'
  GROUP BY 1, 2
  ORDER BY n DESC
  LIMIT 8
`;
console.log("\n群里发言最多的几个：");
for (const row of sample) console.log(`  ${row.name ?? "?"}\t${row.openId ?? "(无)"}\t${row.n}`);
process.exit(0);
