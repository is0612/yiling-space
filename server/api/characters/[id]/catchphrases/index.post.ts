import { createError, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { readTrimmedString, requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { invalidateCatchphraseCache, toCatchphraseDto } from "../../../../utils/catchphrases";
import { normalizePhraseKey } from "../../../../utils/catchphrase-mine";

/** 一次最多贴多少条。贴一整篇小说进来只会把候选池撑爆。 */
const MAX_BATCH = 20;

/**
 * 加梗。支持一条，也支持一次贴一批（`phrases: string[]`）。
 *
 * 为什么要有批量：梗是人在外面刷到、攒着回来记的东西（「网上看到的」，不是群里冒出来的）。
 * 一条一条填两个框，攒十句就得开十个对话框 —— 所以台词框是多行的，一行一句。
 *
 * 批量时**不整批失败**：贴十条其中三条已经存在，剩下七条照收，把跳过的报回去。
 * 整批 409 的话，用户只能自己一句句试哪条重复了。
 *
 * 去重用归一化 key（`normalizePhraseKey`）而不是原文精确匹配：
 * 「不烧心吗？」和「不烧心吗」是同一句。列表里出现两条一模一样的台词，
 * 模型每轮看到两遍，会以为这句特别重要，反而更容易复读。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const body = await readBody<Record<string, unknown>>(event);
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  if (body.phrases !== undefined && !Array.isArray(body.phrases)) {
    throw createError({ statusCode: 400, statusMessage: "phrases 必须是数组。" });
  }
  const rawPhrases: unknown[] = Array.isArray(body.phrases)
    ? body.phrases
    : body.phrase !== undefined ? [body.phrase] : [];

  const phrases = [...new Set(
    rawPhrases
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0),
  )];
  if (!phrases.length) throw createError({ statusCode: 400, statusMessage: "台词不能为空。" });
  if (phrases.length > MAX_BATCH) {
    throw createError({ statusCode: 400, statusMessage: `一次最多加 ${MAX_BATCH} 句。` });
  }
  const tooLong = phrases.find((item) => item.length > 200);
  if (tooLong) throw createError({ statusCode: 400, statusMessage: `台词不能超过 200 个字符：「${tooLong.slice(0, 20)}…」` });

  const usage = readTrimmedString(body.usage, "什么时候说", 300);

  const existing = await prisma.characterCatchphrase.findMany({
    where: { characterId: id },
    select: { phrase: true },
  });
  const existingKeys = new Set(existing.map((row) => normalizePhraseKey(row.phrase)));

  const created: ReturnType<typeof toCatchphraseDto>[] = [];
  const skipped: string[] = [];
  for (const phrase of phrases) {
    if (existingKeys.has(normalizePhraseKey(phrase))) {
      skipped.push(phrase);
      continue;
    }
    const row = await prisma.characterCatchphrase.create({
      data: { characterId: id, phrase, usage },
    });
    // 同一批里前后重复（「就这」「就这？」）也要挡住 —— 只查库挡不住本批内的重复。
    existingKeys.add(normalizePhraseKey(phrase));
    created.push(toCatchphraseDto(row));
  }

  invalidateCatchphraseCache(id);
  return { created, skipped };
});
