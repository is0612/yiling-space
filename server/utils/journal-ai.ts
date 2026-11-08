/**
 * 每日「日记 / 手账」两份文本的生成。
 *
 * 它们共用同一天的素材，但是**两份独立产物**：
 *   - 日记（DIARY）：第一人称叙事，讲今天值得记住的经历和感受；
 *   - 手账（HANDBOOK）：结构化记录，短句/列表，留片段、想法、一句、灵感、待续。
 * 不能拿日记截断当手账，也不能把手账列表扩写成日记。
 *
 * 三条服务端硬规则：
 *   1. 来源消息 / 忆泡必须是本次输入里真实出现过的 ID；
 *   2. 手账的 `quote` 必须是某一版日记正文里的连续原文（只忽略空白）；
 *   3. 没有值得写的内容时允许 SKIP，不生成空文本。
 */

import { composeCharacterPrompt } from "./chat-reply";
import { formatMentionContent, type ConversationMessageMention } from "./conversation-message";
import { parseJsonLoose } from "./loose-json";
import { callRawModel } from "./raw-llm";
import type { ModelUsageTokens } from "./model-usage";

export const DIARY_PROMPT_VERSION = "journal-diary-v3";
export const HANDBOOK_PROMPT_VERSION = "journal-handbook-v3";

/**
 * 日记的硬性下限只用来挡住空内容、纯符号和明显重复的占位文本；
 * 「平淡的一天可以更短」是产品要求，不能靠凑字数过校验。
 */
export const DIARY_CONTENT_MIN = 8;
export const DIARY_CONTENT_MAX = 2000;
/** 手账正文允许为空：只留下一条想法或一句也算手账。 */
export const HANDBOOK_CONTENT_MAX = 1500;
export const HANDBOOK_THOUGHT_MAX = 300;
export const HANDBOOK_QUOTE_MIN = 6;
export const HANDBOOK_QUOTE_MAX = 120;
export const HANDBOOK_TAG_LIMIT = 6;
/** 每类栏目最多几条。 */
const HANDBOOK_SECTION_LIMIT = 6;
const HANDBOOK_LINE_MAX = 120;

export type JournalAiMessage = {
  id: string;
  role: string;
  occurredAt: string;
  content: string;
  origin?: string;
  isOwner?: boolean;
  mentionTargets?: string[];
  /** 这条消息 @ 到的具体对象：代号 / 显示名 / 身份。 */
  mentions?: ConversationMessageMention[];
  /** 这条是群里哪个人说的（显示名）。群聊里一条 USER 可能是主人、群友、别的 bot。 */
  speaker?: string;
  /** 群内稳定代号（`member_2`）：昵称会改，代号不会。 */
  member?: string;
};

export type JournalAiEvent = {
  id: string;
  occurredAt: string;
  title: string;
  detail: string;
};

export type JournalAiInput = {
  apiKey: string;
  apiBaseUrl?: string;
  model: string;
  dayKey: string;
  timezone: string;
  characterName: string;
  basePrompt: string;
  styleExamples?: string;
  messages: JournalAiMessage[];
  events: JournalAiEvent[];
  totalMessageCount: number;
  omittedMessageCount: number;
};

export type DiaryAiCreate = {
  action: "CREATE";
  title?: string;
  content: string;
  sourceMessageIds: string[];
  sourceEventIds: string[];
};

export type HandbookAiCreate = {
  action: "CREATE";
  content: string;
  thought?: string;
  quote?: string;
  tags: string[];
  sourceMessageIds: string[];
  sourceEventIds: string[];
};

/** 生成输入里真实存在的来源文本，用来校验 evidence.quote 不是凭空编的。 */
export type JournalEvidenceSourceTexts = {
  messages?: ReadonlyMap<string, string>;
  events?: ReadonlyMap<string, string>;
};

export type JournalAiSkip = { action: "SKIP"; reason: string };
export type DiaryAiEntry = DiaryAiCreate | JournalAiSkip;
export type HandbookAiEntry = HandbookAiCreate | JournalAiSkip;

export type JournalAiResult<T> = {
  entry: T;
  model: string;
  promptVersion: string;
  usage?: ModelUsageTokens;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

/** 摘句比对用的归一化：去掉全部空白。中文里空白不是语义。 */
function normalizeQuoteText(value: string): string {
  return value.replace(/\s+/gu, "").trim();
}

/** 「一句」是不是日记正文里的连续原文。只忽略空白，不改标点和字。 */
export function isQuoteFromContent(content: string, quote: string): boolean {
  const normalizedContent = normalizeQuoteText(content);
  const normalizedQuote = normalizeQuoteText(quote);
  if (!normalizedQuote) return false;
  return normalizedContent.includes(normalizedQuote);
}

function readIdList(value: unknown, validIds: Set<string>, max = 60): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string" && validIds.has(id)))].slice(0, max);
}

function readLineList(value: unknown, max = HANDBOOK_SECTION_LIMIT): string[] {
  if (!Array.isArray(value)) return [];
  const lines: string[] = [];
  for (const entry of value.slice(0, max)) {
    if (typeof entry !== "string") continue;
    const line = entry.trim().slice(0, HANDBOOK_LINE_MAX);
    if (line && !lines.includes(line)) lines.push(line);
  }
  return lines;
}

function readTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const entry of value.slice(0, HANDBOOK_TAG_LIMIT)) {
    if (typeof entry !== "string") continue;
    const tag = entry.trim().slice(0, 20);
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

function hasSources(sourceMessageIds: string[], sourceEventIds: string[]): boolean {
  return sourceMessageIds.length > 0 || sourceEventIds.length > 0;
}

/** 日记正文的有效性：拒绝空、纯符号、重复占位；不要求凑到推荐字数。 */
export function diaryContentError(content: string): string | null {
  const text = content.trim();
  const compact = text.replace(/\s+/gu, "");
  if (!compact) return "日记正文不能为空。";
  if (compact.length < DIARY_CONTENT_MIN) {
    return `日记正文太短（至少 ${DIARY_CONTENT_MIN} 个有效字符）。`;
  }
  if (!/[\p{L}\p{N}]/u.test(compact)) return "日记正文必须包含实际文字。";
  if (new Set(compact).size < 3) return "日记正文内容过于重复。";
  return null;
}

type HandbookEvidence = {
  text: string;
  quote: string;
  sourceMessageIds: string[];
  sourceEventIds: string[];
};

function isEvidenceQuoteInSource(source: string, quote: string): boolean {
  const sourceText = normalizeQuoteText(source);
  const quoteText = normalizeQuoteText(quote);
  if (!sourceText || !quoteText) return false;
  // 单字来源（「嗯」）只能整段相等；否则「嗯」会匹配到任何一句话。
  if (quoteText.length === 1) return sourceText === quoteText;
  return sourceText.includes(quoteText);
}

/** 去掉空白和标点，只比较实际内容，避免「今天，」这种公共片段造成假重叠。 */
function evidenceCompareText(value: string): string {
  return value.replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * evidence.text 和来源文本至少要有 4 个连续字的重叠（短文本按包含算）。
 * 只校验 quote 在来源里不够：模型可以拿一条真实消息，却把完全无关的格言
 * 挂到它上面。4 字是「具体经历/观点」的最低门槛，避免整句通用格言通过。
 */
function hasContentOverlap(left: string, right: string): boolean {
  const a = evidenceCompareText(left);
  const b = evidenceCompareText(right);
  if (!a || !b) return false;
  if (a.length < 4 || b.length < 4) return a.includes(b) || b.includes(a);
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  for (let index = 0; index + 4 <= shorter.length; index += 1) {
    if (longer.includes(shorter.slice(index, index + 4))) return true;
  }
  return false;
}

/**
 * 手账每条栏目需要带一条 evidence：栏目原文 + 真实来源 ID + 来源里的连续原文。
 *
 * 只做轻量校验：ID 必须来自本次输入，quote 必须能在这些来源文本里找到。
 * 没有 evidence 的栏目会在下面被丢掉，不会静默保存成「有依据」。
 */
function readEvidenceList(
  value: unknown,
  validMessageIds: Set<string>,
  validEventIds: Set<string>,
  sourceTexts: JournalEvidenceSourceTexts,
): HandbookEvidence[] {
  if (!Array.isArray(value)) return [];
  const evidence: HandbookEvidence[] = [];
  for (const raw of value.slice(0, 24)) {
    const record = asRecord(raw);
    if (!record) continue;
    const text = asText(record.text, HANDBOOK_THOUGHT_MAX);
    const quote = asText(record.quote, 300);
    const sourceMessageIds = readIdList(record.sourceMessageIds, validMessageIds, 8);
    const sourceEventIds = readIdList(record.sourceEventIds, validEventIds, 8);
    if (!text || !quote || !hasSources(sourceMessageIds, sourceEventIds)) continue;
    const messageMatch = sourceMessageIds.some((id) => {
      const source = sourceTexts.messages?.get(id) ?? "";
      return isEvidenceQuoteInSource(source, quote) && hasContentOverlap(text, source);
    });
    const eventMatch = sourceEventIds.some((id) => {
      const source = sourceTexts.events?.get(id) ?? "";
      return isEvidenceQuoteInSource(source, quote) && hasContentOverlap(text, source);
    });
    if (!messageMatch && !eventMatch) continue;
    evidence.push({ text, quote, sourceMessageIds, sourceEventIds });
  }
  return evidence;
}

function evidenceSupportsLine(evidence: HandbookEvidence, line: string): boolean {
  const lineText = normalizeQuoteText(line);
  const evidenceText = normalizeQuoteText(evidence.text);
  return Boolean(lineText && evidenceText && lineText.includes(evidenceText));
}

function unionIds(target: string[], values: Iterable<string>): void {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
}

/** 日记：第一人称叙事。 */
export function validateDiaryAiOutput(
  raw: unknown,
  validMessageIds: Iterable<string>,
  validEventIds: Iterable<string>,
): DiaryAiEntry {
  const root = asRecord(raw);
  if (!root) throw new Error("LLM_INVALID_JSON: 日记输出必须是 JSON 对象。");

  const action = asText(root.action, 20).toUpperCase();
  if (action === "SKIP") {
    return { action: "SKIP", reason: asText(root.reason, 300) || "今天没有值得写进日记的事。" };
  }
  if (action !== "CREATE") {
    throw new Error("LLM_INVALID_ACTION: 日记输出必须带 action=CREATE 或 action=SKIP。");
  }

  const content = asText(root.content, 4000);
  const contentError = diaryContentError(content);
  if (contentError) {
    throw new Error(`LLM_INVALID_CONTENT: ${contentError}`);
  }
  if (content.length > DIARY_CONTENT_MAX) {
    throw new Error(`LLM_INVALID_CONTENT: 日记正文太长（最多 ${DIARY_CONTENT_MAX} 字）。`);
  }

  const validMessages = new Set(validMessageIds);
  const validEvents = new Set(validEventIds);
  const sourceMessageIds = readIdList(root.sourceMessageIds, validMessages);
  const sourceEventIds = readIdList(root.sourceEventIds, validEvents);
  if (!hasSources(sourceMessageIds, sourceEventIds)) {
    throw new Error("LLM_INVALID_SOURCES: 日记没有引用本次输入里的任何来源消息或忆泡。");
  }

  const title = asText(root.title, 120);
  return {
    action: "CREATE",
    content,
    ...(title ? { title } : {}),
    sourceMessageIds,
    sourceEventIds,
  };
}

/**
 * 把手账的栏目拼成正文。
 *
 * 「今日想法」「今日一句」「标签」各自是独立字段，不重复塞进正文；
 * 正文只有片段 / 灵感 / 待续三节，页面按小标题渲染。
 */
export function renderHandbookContent(input: {
  snippets: string[];
  inspirations: string[];
  followUps: string[];
}): string {
  const sections: string[] = [];
  if (input.snippets.length) {
    sections.push(["## 今日片段", ...input.snippets.map((line) => `- ${line}`)].join("\n"));
  }
  if (input.inspirations.length) {
    sections.push(["## 灵感与发现", ...input.inspirations.map((line) => `- ${line}`)].join("\n"));
  }
  if (input.followUps.length) {
    sections.push(["## 待续事项", ...input.followUps.map((line) => `- ${line}`)].join("\n"));
  }
  return sections.join("\n\n");
}

/** 手账：结构化记录；quote 必须来自 diaryContent（如果那天有日记）。 */
export function validateHandbookAiOutput(
  raw: unknown,
  validMessageIds: Iterable<string>,
  validEventIds: Iterable<string>,
  diaryContent: string | null,
  sourceTexts: JournalEvidenceSourceTexts = {},
): HandbookAiEntry {
  const root = asRecord(raw);
  if (!root) throw new Error("LLM_INVALID_JSON: 手账输出必须是 JSON 对象。");

  const action = asText(root.action, 20).toUpperCase();
  if (action === "SKIP") {
    return { action: "SKIP", reason: asText(root.reason, 300) || "今天没有值得写进手账的东西。" };
  }
  if (action !== "CREATE") {
    throw new Error("LLM_INVALID_ACTION: 手账输出必须带 action=CREATE 或 action=SKIP。");
  }

  const validMessages = new Set(validMessageIds);
  const validEvents = new Set(validEventIds);
  const evidence = readEvidenceList(root.evidence, validMessages, validEvents, sourceTexts);
  const keptEvidence: HandbookEvidence[] = [];
  const keepLine = (line: string): boolean => {
    const matched = evidence.filter((entry) => evidenceSupportsLine(entry, line));
    if (matched.length) keptEvidence.push(...matched);
    return matched.length > 0;
  };

  const rawSnippets = readLineList(root.snippets);
  const rawInspirations = readLineList(root.inspirations);
  const rawFollowUps = readLineList(root.followUps);
  const rawThought = asText(root.thought, HANDBOOK_THOUGHT_MAX);
  const snippets = rawSnippets.filter(keepLine);
  const inspirations = rawInspirations.filter(keepLine);
  const followUps = rawFollowUps.filter(keepLine);
  const thought = rawThought && keepLine(rawThought) ? rawThought : undefined;
  const tags = readTags(root.tags);

  const sourceMessageIds = readIdList(root.sourceMessageIds, validMessages);
  const sourceEventIds = readIdList(root.sourceEventIds, validEvents);
  for (const entry of keptEvidence) {
    unionIds(sourceMessageIds, entry.sourceMessageIds);
    unionIds(sourceEventIds, entry.sourceEventIds);
  }
  if (!hasSources(sourceMessageIds, sourceEventIds)) {
    throw new Error("LLM_INVALID_SOURCES: 手账没有引用本次输入里的任何来源消息或忆泡。");
  }

  const content = renderHandbookContent({ snippets, inspirations, followUps }).slice(0, HANDBOOK_CONTENT_MAX);

  const quoteRaw = asText(root.quote, HANDBOOK_QUOTE_MAX + 20);
  const quote = diaryContent
    && quoteRaw.length >= HANDBOOK_QUOTE_MIN
    && quoteRaw.length <= HANDBOOK_QUOTE_MAX
    && isQuoteFromContent(diaryContent, quoteRaw)
    ? quoteRaw
    : undefined;

  // 一个栏目都没有，就不算手账。模型写了内容但全部没有 evidence 时，
  // 说明来源证据不足，必须明确报错，不能静默保存或悄悄改成 SKIP。
  if (!content && !thought && !quote && tags.length === 0) {
    const hadRawContent = rawSnippets.length > 0
      || rawInspirations.length > 0
      || rawFollowUps.length > 0
      || Boolean(rawThought);
    throw new Error(hadRawContent
      ? "LLM_INVALID_CONTENT: 手账栏目没有可验证的来源证据，已拒绝保存。"
      : "LLM_INVALID_CONTENT: 手账没有任何可保留的内容。");
  }

  return {
    action: "CREATE",
    content,
    ...(thought ? { thought } : {}),
    ...(quote ? { quote } : {}),
    tags,
    sourceMessageIds,
    sourceEventIds,
  };
}

function addUsage(left: ModelUsageTokens | null, right: ModelUsageTokens): ModelUsageTokens {
  if (!left) return { ...right };
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    ...(left.reasoningTokens !== undefined || right.reasoningTokens !== undefined
      ? { reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0) }
      : {}),
    ...(left.cacheHitTokens !== undefined || right.cacheHitTokens !== undefined
      ? { cacheHitTokens: (left.cacheHitTokens ?? 0) + (right.cacheHitTokens ?? 0) }
      : {}),
    ...(left.cacheMissTokens !== undefined || right.cacheMissTokens !== undefined
      ? { cacheMissTokens: (left.cacheMissTokens ?? 0) + (right.cacheMissTokens ?? 0) }
      : {}),
  };
}

/** 提示词输入：只带必要字段，供测试直接断言提示词内容。 */
export function promptInput(input: JournalAiInput, extra: Record<string, unknown> = {}) {
  return {
    characterName: input.characterName,
    dayKey: input.dayKey,
    timezone: input.timezone,
    totalMessageCount: input.totalMessageCount,
    omittedMessageCount: input.omittedMessageCount,
    messages: input.messages.map(({ id, role, occurredAt, content, origin, isOwner, mentionTargets, mentions, speaker, member }) => {
      // 和记忆提炼同一套：正文的真实 QQ 换成 @member_n，对应关系由 mentions 给。
      const promptContent = mentions?.length ? formatMentionContent(content, mentions) : content;
      const promptMentions = mentions?.map(({ qq: _qq, ...rest }) => rest);
      return {
        id,
        role,
        occurredAt,
        content: promptContent,
        ...(origin ? { origin } : {}),
        ...(isOwner ? { isOwner } : {}),
        ...(mentionTargets?.length ? { mentionTargets } : {}),
        ...(promptMentions?.length ? { mentions: promptMentions } : {}),
        // 发言人：群聊里一条 USER 可能是主人、群友甲、群友乙或别的 bot，
        // 没有这个字段模型会把别人做的事算到她头上。
        ...(speaker ? { speaker } : {}),
        ...(member ? { member } : {}),
      };
    }),
    events: input.events.map(({ id, occurredAt, title, detail }) => ({ id, occurredAt, title, detail })),
    ...extra,
  };
}

async function callJournalModel(
  input: JournalAiInput,
  options: { systemPrompt: string; userPrompt: string; temperature: number },
): Promise<{ text: string; usage: ModelUsageTokens | null }> {
  let usage: ModelUsageTokens | null = null;
  const text = await callRawModel({
    systemPrompt: options.systemPrompt,
    userPrompt: options.userPrompt,
    model: input.model,
    apiKey: input.apiKey,
    ...(input.apiBaseUrl ? { apiBaseUrl: input.apiBaseUrl } : {}),
    temperature: options.temperature,
    // 思考型模型会先花掉一部分预算在 reasoning 上；日记上限 2000 字，
    // 4096 在长日记 + 思考时可能把正文截断（callRawModel 只在正文为空时翻倍，
    // 非空截断不会重试），所以直接给 8192。max_tokens 只在真的用到时计费。
    maxTokens: 8192,
    timeoutMs: 120_000,
    onUsage: (value) => {
      usage = addUsage(usage, value);
    },
  });
  return { text, usage };
}

export function diarySystemPrompt(input: JournalAiInput): string {
  return [
    composeCharacterPrompt(input.basePrompt.slice(0, 12_000), input.styleExamples),
    "",
    "## 写今天的日记（不是写回复，也不是写日报）",
    "",
    "你正在用第一人称写今天的日记。读者是你自己。",
    "",
    "- 选一到两件今天真的发生的事展开：当时怎么想、什么没说出口、事后有没有重新理解。",
    "- 写经历和感受，不要复述所有事件，也不要写成工作日报。",
    "- 只写材料里有的东西：不要编天气、场景、动作、感官细节，也不要编对话。",
    "- **认清说话的人**：材料里 `role: assistant` 才是你自己说的；`role: user` 要看 `speaker`（谁说的）与 `isOwner`（是不是主人）。群聊里一条 user 可能是主人、群友甲、群友乙，甚至是别的 bot。",
    "- **看清被 @ 的是谁**：消息上的 `mentions` 是 @ 对象（target=self 是你，all 是全体，other 是别人；speaker/kind 是对方的显示名与身份）。@other 的话不是对你说的；@ 后面的称呼、外号属于那个对象，不能写进你自己的日记里当成别人在叫你。",
    "- 别人说的事是**别人的**：群友去旅行、群友心情不好、主人今天很累，都不是你经历的事。你可以写「听谁说起」，但不能写成自己做的、自己的情绪。只有你自己说过的、真正参与过的事才用第一人称当作亲历。",
    "- 分不清某句话是谁说的，就别把它写进日记。",
    ...(input.messages.length === 0 && input.events.length > 0
      ? ["- 这一天的原始消息已经不在，只剩下忆泡。只能根据忆泡的标题和详情写；不要编造对话原文，也不要假装记得未记录的场景。细节不够就写短，或者 SKIP。"]
      : []),
    "- 允许不开心、不满、疑惑、矛盾；也允许这一天没有感悟。",
    "- 普通日记 150-400 字比较合适，平淡的一天可以更短；不要为了凑字数扩写。空内容、纯符号或明显重复的占位文本会被拒绝。完全没有值得写的事就返回 SKIP。",
    "",
    "只输出 JSON，不要 Markdown 代码围栏，不要解释。格式：",
    JSON.stringify({
      action: "CREATE",
      title: "可选，给这一天起个短标题（不超过 12 字）",
      content: "第一人称日记正文",
      sourceMessageIds: ["输入里真实出现的消息 ID"],
      sourceEventIds: ["输入里真实出现的忆泡 ID"],
    }, null, 2),
    "或者：",
    JSON.stringify({ action: "SKIP", reason: "今天没有值得写进日记的事。" }, null, 2),
  ].join("\n");
}

export function handbookSystemPrompt(input: JournalAiInput): string {
  return [
    composeCharacterPrompt(input.basePrompt.slice(0, 12_000), input.styleExamples),
    "",
    "## 写今天的手账（不是日记的缩写，也不是第二份忆泡）",
    "",
    "手账是一页结构化记录：短句、列表、有选择地留，只写今天值得收藏的。",
    "",
    "- 今日片段：2-4 条短句，挑一两个值得留的瞬间；不要把当天所有事罗列一遍。",
    "- 今日想法：1-2 句，必须有今天的经历支撑，不要写通用格言。",
    "- 今日一句：从下面的日记正文里**原样摘一段连续原文**（不改写、不拼接、不加引号、不改标点）；没有日记或没有合适的就留空。",
    "- 灵感与发现：今天产生的小发现、想法或灵感，可空。",
    "- 待续事项：还没结束、想继续关注的事，可空。",
    "- 标签：1-5 个主题词。",
    "- **认清说话的人**：`role: assistant` 才是你自己；`role: user` 要看 `speaker` / `isOwner`，群聊里可能是主人、群友，甚至别的 bot。别人经历的事只能记成「听谁说起」，不能记成自己做的。",
    "- **看清被 @ 的是谁**：`mentions` 是 @ 对象；target=other 不是你在被叫，@ 后面的称呼属于对方，不能记成你的外号或别人对你的称呼。",
    ...(input.messages.length === 0 && input.events.length > 0
      ? ["- 这一天的原始消息已经不在，只剩下忆泡。只能根据忆泡的标题和详情写；不要编造对话原文或未记录的场景。某个栏目没有来源支撑就留空。"]
      : []),
    "",
    "每条片段 / 想法 / 灵感 / 待续都要在 evidence 里挂一条依据：把栏目原文复制到 text，并给出输入里真实存在的来源 ID 和该来源里的连续原文 quote。没有依据的栏目会被服务端丢掉；不要为了通过校验编造来源。今日一句不需要 evidence（它只能摘日记）。",
    "没有值得记录的内容就返回 SKIP；不要为了填满栏目硬写。",
    "",
    "只输出 JSON，不要 Markdown 代码围栏，不要解释。格式：",
    JSON.stringify({
      action: "CREATE",
      snippets: ["今日片段，一条一句"],
      thought: "今日想法；没有就留空",
      quote: "日记正文里的连续原文；没有就留空",
      inspirations: ["灵感或发现；没有就留空"],
      followUps: ["待续事项；没有就留空"],
      tags: ["标签"],
      sourceMessageIds: ["输入里真实出现的消息 ID"],
      sourceEventIds: ["输入里真实出现的忆泡 ID"],
      evidence: [{
        text: "上面某个片段 / 想法 / 灵感 / 待续的原文",
        quote: "来源里支持这条的连续原文",
        sourceMessageIds: ["输入里真实出现的消息 ID"],
        sourceEventIds: ["输入里真实出现的忆泡 ID"],
      }],
    }, null, 2),
    "或者：",
    JSON.stringify({ action: "SKIP", reason: "今天没有值得写进手账的东西。" }, null, 2),
  ].join("\n");
}

export async function generateDiary(input: JournalAiInput): Promise<JournalAiResult<DiaryAiEntry>> {
  const { text, usage } = await callJournalModel(input, {
    systemPrompt: diarySystemPrompt(input),
    userPrompt: JSON.stringify(promptInput(input)),
    temperature: 0.6,
  });
  const parsed = parseJsonLoose(text, { expect: "object" });
  const entry = validateDiaryAiOutput(
    parsed,
    input.messages.map((message) => message.id),
    input.events.map((event) => event.id),
  );
  return {
    entry,
    model: input.model,
    promptVersion: DIARY_PROMPT_VERSION,
    ...(usage ? { usage } : {}),
  };
}

export async function generateHandbook(
  input: JournalAiInput,
  diary: { revisionId: string; content: string } | null,
): Promise<JournalAiResult<HandbookAiEntry>> {
  const { text, usage } = await callJournalModel(input, {
    systemPrompt: handbookSystemPrompt(input),
    userPrompt: JSON.stringify(promptInput(input, {
      // 手账不是凭空写的：把当天日记正文一起给它，想法和摘句都要从这里来。
      diary: diary ? { content: diary.content } : null,
    })),
    temperature: 0.4,
  });
  const parsed = parseJsonLoose(text, { expect: "object" });
  const entry = validateHandbookAiOutput(
    parsed,
    input.messages.map((message) => message.id),
    input.events.map((event) => event.id),
    diary?.content ?? null,
    {
      messages: new Map(input.messages.map((message) => [message.id, message.content])),
      events: new Map(input.events.map((event) => [event.id, `${event.title}\n${event.detail}`])),
    },
  );
  return {
    entry,
    model: input.model,
    promptVersion: HANDBOOK_PROMPT_VERSION,
    ...(usage ? { usage } : {}),
  };
}
