import { createHash } from "node:crypto";
import { createError } from "h3";
import { Prisma, type PrismaClient } from "../../src/generated/prisma/client";
import { isSystemBroadcast } from "./system-message";

export const GROUP_OBSERVATION_SOURCE = "GROUP_OBSERVATION";
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const maxMessages = 12;
const maxSpanMs = 15 * 60_000;
type Selection = { conversationId: string; openingId: string; responseId: string; outcomeId: string };
type DB = PrismaClient | Prisma.TransactionClient;

export function parseGroupObservationSelection(value: unknown): Selection {
  const keys = ["conversationId", "openingId", "responseId", "outcomeId"] as const;
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== keys.length || keys.some(key => typeof row[key] !== "string" || !uuid.test(row[key]))) {
    throw createError({ statusCode: 400, statusMessage: "请选择开场、接话和后续三条群消息。" });
  }
  const selection = Object.fromEntries(keys.map(key => [key, (row[key] as string).toLowerCase()])) as Selection;
  if (new Set([selection.openingId, selection.responseId, selection.outcomeId]).size !== 3) throw createError({ statusCode: 400, statusMessage: "请选择三条不同的群消息。" });
  return selection;
}
function metadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const stale = () => createError({ statusCode: 409, statusMessage: "群聊片段已变更、已失效或不属于当前角色。" });
const invalid = (message: string) => createError({ statusCode: 422, statusMessage: message });

/** This is a selected window, including the messages between the three anchors. */
export async function loadGroupObservationEvidence(db: DB, characterId: string, selection: Selection, lock?: Prisma.TransactionClient) {
  if (lock) {
    await lock.$queryRaw`SELECT c."id" FROM "conversations" c JOIN "memory_scopes" s ON s."id"=c."memoryScopeId" WHERE c."id"=${selection.conversationId}::uuid AND c."characterId"=${characterId}::uuid FOR SHARE OF c,s`;
  }
  const room = await db.conversation.findFirst({ where: { id: selection.conversationId, characterId,
    externalConversationId: { startsWith: "g:" }, memoryScope: { characterId, scopeType: "CHARACTER_GLOBAL" },
    channelBinding: { characterId, connection: { platform: "qq-onebot" } },
  }, select: { id: true, memoryScopeId: true } });
  if (!room) throw stale();
  const ids = [selection.openingId, selection.responseId, selection.outcomeId];
  const anchors = await db.message.findMany({ where: { id: { in: ids }, conversationId: room.id }, select: { id: true, occurredAt: true } });
  if (anchors.length !== 3) throw stale();
  const [opening, response, outcome] = ids.map(id => anchors.find(row => row.id === id)!);
  if (!(opening!.occurredAt < response!.occurredAt && response!.occurredAt < outcome!.occurredAt) || outcome!.occurredAt.getTime() - opening!.occurredAt.getTime() > maxSpanMs) {
    throw invalid("片段必须按开场、接话、后续排序，且在 15 分钟内。");
  }
  if (lock) {
    await lock.$queryRaw`SELECT "id" FROM "messages" WHERE "conversationId"=${room.id}::uuid AND "occurredAt">=${opening!.occurredAt} AND "occurredAt"<=${outcome!.occurredAt} ORDER BY "occurredAt","id" LIMIT ${maxMessages + 1} FOR SHARE`;
  }
  const rows = await db.message.findMany({ where: { conversationId: room.id, occurredAt: { gte: opening!.occurredAt, lte: outcome!.occurredAt } },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }], take: maxMessages + 1,
    select: { id: true, role: true, content: true, occurredAt: true, metadata: true, externalMessageId: true },
  });
  if (rows.length > maxMessages || rows[0]?.id !== opening!.id || rows.at(-1)?.id !== outcome!.id || !rows.some(row => row.id === response!.id)) throw invalid("请选择间隔较短、最多 12 条消息且边界清楚的片段。");
  if (rows.some(row => row.role === "ASSISTANT")) throw invalid("请选择她没参与的一段群聊。她自己的回复请走「从反馈学习」。");
  const author = (row: typeof rows[number]) => {
    const id = metadata(row.metadata).authorOpenId;
    return typeof id === "string" && id ? id : "";
  };
  const authors = [...new Set(rows.map(author).filter(Boolean))];
  const bots = await db.externalIdentity.findMany({ where: { platform: "qq-onebot", platformUid: { in: authors }, kind: "AI" }, select: { platformUid: true } });
  const excluded = new Set(bots.map(row => row.platformUid));
  const eligible = rows.filter(row => row.role === "USER" && author(row) && !excluded.has(author(row)) && metadata(row.metadata).systemBroadcast !== true && row.content.trim() && !isSystemBroadcast(row.content));
  const selected = ids.map(id => eligible.find(row => row.id === id));
  if (selected.some(row => !row) || author(selected[0]!) === author(selected[1]!) || author(selected[2]!) === author(selected[1]!)) {
    throw invalid("开场与接话要来自不同的人，后续不能只由接话者自己给出。三条依据都须有可辨认的发言人，且不能是已知机器人或系统播报。");
  }
  const aliases = new Map([...new Set(eligible.map(author))].map((id, index) => [id, `成员${index + 1}`]));
  const names = [...new Set(eligible.map(row => metadata(row.metadata).authorDisplayName).filter((name): name is string => typeof name === "string" && name.trim().length >= 2))].sort((a, b) => b.length - a.length);
  const localOrdinals = new Map(eligible.map((row, index) => [row.externalMessageId, index + 1]));
  const mask = (content: string) => {
    let value = content.replace(/https?:\/\/\S+/giu, "[链接]").replace(/\[CQ:[^\]]+\]/giu, "[消息标记]").replace(/\d{5,}/gu, "[数字]");
    for (const name of names) value = value.split(name).join("[成员称呼]");
    return value.slice(0, 400);
  };
  const messages = eligible.map((row, index) => {
    const raw = row.content.trim();
    const quoted = metadata(metadata(row.metadata).quotedMessage);
    const quoteId = typeof quoted.messageId === "string" ? localOrdinals.get(quoted.messageId) : undefined;
    return { line: index + 1, speaker: aliases.get(author(row)), second: Math.floor((row.occurredAt.getTime() - opening!.occurredAt.getTime()) / 1000),
      ...(quoteId ? { quotesLine: quoteId } : {}), mark: row.id === selection.openingId ? "opening" : row.id === selection.responseId ? "response" : row.id === selection.outcomeId ? "outcome" : undefined,
      format: raw === "[图片]" ? "image_placeholder" : /^(?:\[[^\[\]\n]{1,12}\]|\p{Extended_Pictographic}|\uFE0F|\u200D)+$/u.test(raw) ? "possible_emoji_or_placeholder" : "text",
      content: mask(raw),
    };
  });
  const hash = createHash("sha256").update(JSON.stringify([room.id, room.memoryScopeId, selection, rows, [...excluded].sort()])).digest("hex");
  return { hash, messages, names, originals: eligible.map(row => row.content), occurredAt: opening!.occurredAt.toISOString() };
}

export async function assertGroupObservationCurrent(tx: Prisma.TransactionClient, characterId: string, refs: unknown) {
  if (!Array.isArray(refs) || refs.length !== 1 || refs[0]?.type !== GROUP_OBSERVATION_SOURCE) throw stale();
  try {
    const evidence = await loadGroupObservationEvidence(tx, characterId, parseGroupObservationSelection(refs[0].selection), tx);
    if (evidence.hash !== refs[0].hash) throw stale();
  } catch (error) {
    if (error && typeof error === "object" && "statusCode" in error && [400, 409, 422].includes(Number(error.statusCode))) throw stale();
    throw error;
  }
}
