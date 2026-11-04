import type { PrismaClient } from "../../src/generated/prisma/client";

/**
 * 从她自己的手账里捞出「关于她本人」的几句事实。
 *
 * 为什么需要：2026-11-04 在群里问「你记得你生日吗」，她答「没有找到足够可靠的内容」，
 * 可手账 11-02 那篇白纸黑字写着「今天被定了生日，10月30号」。手账是 CHARACTER_GLOBAL
 * 范围、群聊本来就能读，只是检索链路从来没查过它 —— 生日、外观、名字这类稳定事实
 * 只落在手账里，群聊就永远答不出来。
 *
 * 只做「稳定事实」：生日、名字、年龄、外观、喜好。**能力/功能类不查**（语音、看图、表情、
 * 模型）—— 那些会随配置变化，手账里写的是「当时还不会」，翻出来只会把旧状态当现状。
 * 能力由 `modelConfig` 决定，别从手账里猜。
 *
 * 输出的句子带 dayKey：「今天」在手账里是写那天的今天，不换算成现在，模型才不会说错日子。
 */

export type JournalFact = { dayKey: string; text: string };

/** 只认这些「稳定事实」关键词；能力类故意不在里面。 */
const SELF_FACT_TERMS = [
  "生日", "出生", "名字", "叫什么", "几岁", "年龄",
  "外观", "长相", "长什么样", "尾巴", "耳朵", "头发", "颜色",
  "喜欢什么", "讨厌什么", "爱吃什么", "不吃什么",
] as const;

/**
 * 这轮是不是在问「关于她自己的稳定事实」。
 *
 * 判据窄：宁可少查一次，也不要把手账里的私事翻到群里。能力类（语音/看图/表情）
 * 明确排除 —— 那些该看当前配置，不该看手账。
 */
export function isSelfFactQuery(text: string): boolean {
  const value = text.normalize("NFKC").trim();
  if (!value) return false;
  if (/(语音|看图|识图|表情|功能|模型|AI|bot|程序|系统)/iu.test(value)) return false;
  return SELF_FACT_TERMS.some((term) => value.includes(term));
}

/** 从问句里取出命中的关键词；返回空数组表示这轮不该查手账。 */
export function selfFactTerms(text: string): string[] {
  const value = text.normalize("NFKC");
  return SELF_FACT_TERMS.filter((term) => value.includes(term));
}

function splitSentences(content: string): string[] {
  return content
    .split(/[\n。！？!?；;]+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 4 && sentence.length <= 240);
}

/**
 * 从手账版本里挑出命中的句子。纯函数，方便单测。
 *
 * 按传入顺序（调用方按时间倒序）取，**只取最新命中的几版**：旧版手账里的
 * 「我还没有 X」会被新版改写，把两版一起喂进去就是让模型自己猜哪个是真的。
 */
export function selectJournalFactSentences(
  revisions: ReadonlyArray<{ dayKey: string; content: string }>,
  terms: readonly string[],
  max = 3,
): JournalFact[] {
  if (!terms.length || max <= 0) return [];
  const facts: JournalFact[] = [];
  const seen = new Set<string>();
  for (const revision of revisions) {
    for (const sentence of splitSentences(revision.content)) {
      if (!terms.some((term) => sentence.includes(term))) continue;
      const key = sentence.replace(/\s+/gu, "");
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push({ dayKey: revision.dayKey, text: sentence.slice(0, 200) });
      if (facts.length >= max) return facts;
    }
    // 一版里已经命中就不再往更旧的版本翻：旧版和新版冲突时，新版才是现状。
    if (facts.length > 0) return facts;
  }
  return facts;
}

/**
 * 读手账里的稳定事实。只读 CHARACTER_GLOBAL —— 私聊范围的手账不进群聊。
 *
 * 只取 DIARY：手账（HANDBOOK）是结构化摘要，句子常常是标签，不适合当事实引用。
 */
export async function loadJournalFacts(
  prisma: Pick<PrismaClient, "journalRevision">,
  input: { characterId: string; query: string; max?: number },
): Promise<JournalFact[]> {
  const terms = selfFactTerms(input.query);
  if (!terms.length) return [];
  const revisions = await prisma.journalRevision.findMany({
    where: {
      kind: "DIARY",
      journal: {
        memoryScope: { characterId: input.characterId, scopeType: "CHARACTER_GLOBAL" },
      },
    },
    orderBy: [{ createdAt: "desc" }, { version: "desc" }],
    take: 30,
    select: { content: true, journal: { select: { dayKey: true } } },
  });
  const rows = revisions.map((revision) => ({
    dayKey: revision.journal.dayKey,
    content: revision.content,
  }));
  return selectJournalFactSentences(rows, terms, input.max ?? 3);
}
