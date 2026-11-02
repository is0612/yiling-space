/**
 * 空间主动：让她自己决定「想发一条什么说说」「想评论朋友的哪条说说」，
 * 想好了就来问主人「我想发这个，行吗」。主人只做同意 / 不同意。
 *
 * 和 `proactive.ts`（主动找话）是两套机制，别混：
 * - `proactive.ts` 的意图池是「想跟他聊什么」，产出是一句私聊；
 * - 这里是「想在自己空间上做什么」，产出是一条**待确认的空间动作**（落 `onebot_qzone_actions`）。
 *
 * 所以它不占 `proactive_intents` 的池子，也不走 `proactive.ts` 的 `dailyMax` ——
 * 它有自己更严的日上限（发说说 / 评论各算），因为这是往公共空间上写东西，风险更高。
 */

import { resolveChatModelSettings } from "../../chat-model-config";
import { resolveCharacterApiKey } from "../../credential-encryption";
import { getPrisma } from "../../prisma";
import { callRawModel } from "../../raw-llm";
import { readDailyQuota, recordModelUsage, type ModelUsageTokens } from "../../model-usage";
import {
  listQzoneFriendMoods,
  createPendingQzoneAction,
  findPendingQzoneAction,
  type QzoneFeed,
} from "./qzone";
import { loadOnebotConnections } from "./configure";
import { sendOnebotPrivateMessage } from "./client";
import { findDeliveryTarget } from "../../proactive";
import { clockMinutesCst, readClockMinutes } from "../../proactive-settings";

/** 一次主动空间意图调用的可能产出。 */
export type QzoneAutoAskResult = {
  status: "post" | "comment" | "none";
  /** POST：说说正文；COMMENT：评论内容。 */
  content: string;
  /** COMMENT 才有：评论目标。 */
  target?: { uin: string; tid: string; nickname: string; excerpt: string };
  model: string;
};

const QZONE_AUTO_PROMPT_MARKER = "YILING_QZONE_AUTO_V1";

type AutoAskCharacter = {
  id: string;
  name: string;
  basePrompt: string;
  styleExamples: string;
  modelConfig: unknown;
};

/**
 * 空间自动问的闸门。
 *
 * 和 `proactive.ts` 一样，先判配置再调模型 —— 但这里的「配置」简单得多：
 * 开关（连接级）+ 主人有没有填 + 有没有绑定。模型额度在生成时判。
 */
export function evaluateQzoneAutoGate(input: {
  qzoneEnabled: boolean;
  qzoneAutoAskEnabled: boolean;
  ownerQq: string;
  hasBinding: boolean;
}): { allowed: boolean; reason: string } {
  const { qzoneEnabled, qzoneAutoAskEnabled, ownerQq, hasBinding } = input;
  if (!qzoneEnabled) return { allowed: false, reason: "qzone_disabled" };
  if (!qzoneAutoAskEnabled) return { allowed: false, reason: "auto_ask_disabled" };
  if (!ownerQq) return { allowed: false, reason: "no_owner" };
  if (!hasBinding) return { allowed: false, reason: "no_binding" };
  return { allowed: true, reason: "ok" };
}

/**
 * 现在到没到「可以主动问」的时间点。
 *
 * tick 每 60 秒跑一次，不是整点准点醒来的，所以判「到点」要带一个容差窗口：
 * 落在某个时间点之后的 5 分钟内都算「到点」，保证 tick 跑得再偏也能踩中一次。
 * 超过容差就算「错过这次」—— 下一天同一时刻再来，别在 22:00 之后把 18:00 的补上。
 */
export function isQzoneAutoAskTime(
  now: Date,
  times: readonly string[],
  toleranceMinutes = 5,
): boolean {
  if (!times.length) return false;
  const current = clockMinutesCst(now);
  for (const time of times) {
    const scheduled = readClockMinutes(time);
    if (scheduled === null) continue;
    const delta = current - scheduled;
    if (delta >= 0 && delta <= toleranceMinutes) return true;
  }
  return false;
}

/** 当天（东八区）已经主动问了几次。落在 `onebot_qzone_actions` 里按「主动」标记统计。 */
export async function countQzoneAutoAskedToday(connectionId: string): Promise<number> {
  const prisma = getPrisma();
  const now = new Date();
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const dayStart = new Date(Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  ) - 8 * 60 * 60 * 1000);
  // 「主动问」的特征：topic 带「主动」标记（"主动想发的说说" / "主动想评论朋友说说"）。
  return prisma.onebotQzoneAction.count({
    where: {
      connectionId,
      topic: { contains: "主动" },
      createdAt: { gte: dayStart },
    },
  });
}

function buildAutoAskSystemPrompt(characterName: string, persona: string, styleExamples: string): string {
  const lines = [
    QZONE_AUTO_PROMPT_MARKER,
    `你是「${characterName}」。下面是你的设定：`,
    "",
    persona.slice(0, 12_000),
  ];
  if (styleExamples.trim()) {
    lines.push("", "## 你平时说话的样子（只学语气，不要照抄）", styleExamples.trim().slice(0, 4_000));
  }
  lines.push(
    "",
    "## 现在要做什么",
    "你现在可能会想在自己的 QQ 空间上做点什么：发一条说说，或者看看朋友的说说、在下面留一句评论。",
    "想做什么、写什么，全由你自己决定。但你没权利直接发 —— 你要先想好内容，交给我转述给主人，等他同意。",
    "",
    "## 硬边界",
    "1. 先看下面给你的素材（最近的记忆、朋友最近的说说）。有感觉才做，没感觉就明确说「没有」。",
    "2. 发说说：像随手记，不像作文；80 字以内；不编造素材里没有的具体事实。",
    "3. 评论：30 字以内，像熟人搭话，不复述对方说了什么、不客套夸「写得好」。",
    "4. 一次只做一件事：要么发说说，要么评一条评论，不要两件一起。",
    "5. 不要说「我要发说说」「我打算」这类元描述，直接给内容本身。",
  );
  return lines.join("\n");
}

function buildAutoAskUserPrompt(input: { memories: string[]; friendMoods: QzoneFeed[] }): string {
  const memoryBlock = input.memories.length
    ? input.memories.map((line) => `- ${line}`).join("\n")
    : "（暂时没有值得回味的记忆）";
  const moodBlock = input.friendMoods.length
    ? input.friendMoods.map((mood, index) => `[${index + 1}] ${mood.nickname}（QQ ${mood.uin}）：${mood.excerpt}`).join("\n")
    : "（没抓到朋友最近的说说）";

  return [
    "## 我还记得的事",
    memoryBlock,
    "",
    "## 朋友最近的说说（可以选一条评论）",
    moodBlock,
    "",
    "现在决定：要不要发一条说说 / 评论一条。只输出一个 JSON 对象，格式如下（二选一）：",
    '发说说 → {"action":"post","content":"说说正文"}',
    '评论 → {"action":"comment","index":1,"content":"评论内容"}（index 是上面朋友说说列表的编号）',
    '什么都不想做 → {"action":"none"}',
    "",
    "只输出这个 JSON，不要任何别的文字。",
  ].join("\n");
}

type AutoAskParsed =
  | { action: "post"; content: string }
  | { action: "comment"; index: number; content: string }
  | { action: "none" };

/** 校验模型输出。宁可判成 none 也不能把一条错误评论发出去。 */
export function parseQzoneAutoAsk(payload: unknown): AutoAskParsed {
  if (!payload || typeof payload !== "object") return { action: "none" };
  const record = payload as Record<string, unknown>;
  const action = record.action;
  if (action === "none") return { action: "none" };

  if (action === "post") {
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (!content) return { action: "none" };
    return { action: "post", content: content.slice(0, 1_000) };
  }
  if (action === "comment") {
    const index = Number(record.index);
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (!Number.isInteger(index) || index < 1 || !content) return { action: "none" };
    return { action: "comment", index, content: content.slice(0, 200) };
  }
  return { action: "none" };
}

/**
 * 生成一次「她自己想做的空间动作」。
 *
 * 返回 `none` 不代表失败 —— 她今天没心情发，这是正常结果，不重试、不报错。
 */
export async function generateQzoneAutoAsk(input: {
  character: AutoAskCharacter;
  friendMoods: QzoneFeed[];
  memories: string[];
}): Promise<{ result: QzoneAutoAskResult; error?: string }> {
  const character = input.character;
  const settings = resolveChatModelSettings(character.modelConfig);
  const apiKey = await resolveCharacterApiKey(character.modelConfig, settings.apiBaseUrl).catch(() => "");
  if (!apiKey || !settings.model) return { result: { status: "none", content: "", model: "" }, error: "model_not_configured" };

  const quota = await readDailyQuota(character.id, character.modelConfig);
  if (quota.exceeded) return { result: { status: "none", content: "", model: "" }, error: "quota_exceeded" };

  let usage: ModelUsageTokens | null = null;
  let reply = "";
  try {
    reply = await callRawModel({
      systemPrompt: buildAutoAskSystemPrompt(character.name, character.basePrompt, character.styleExamples),
      userPrompt: buildAutoAskUserPrompt({ memories: input.memories, friendMoods: input.friendMoods }),
      model: settings.model,
      apiKey,
      apiBaseUrl: settings.apiBaseUrl,
      temperature: 0.9,
      maxTokens: Math.min(Math.max(settings.maxTokens, 300), 800),
      onUsage: (value) => { usage = value; },
    });
  } catch (error) {
    return {
      result: { status: "none", content: "", model: settings.model },
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const parsed = parseQzoneAutoAsk(parseJson(reply));
  const base = { model: settings.model };

  if (parsed.action === "none") {
    return { result: { status: "none", content: "", ...base } };
  }
  if (parsed.action === "post") {
    await recordModelUsage({
      kind: "channel", model: settings.model, usage,
      characterId: character.id, metadata: { task: "qzone-auto-post" },
    });
    return { result: { status: "post", content: parsed.content, ...base } };
  }
  // comment：需要从朋友说说里找到 index 对应的那条。
  const target = input.friendMoods[parsed.index - 1];
  await recordModelUsage({
    kind: "channel", model: settings.model, usage,
    characterId: character.id, metadata: { task: "qzone-auto-comment" },
  });
  if (!target) return { result: { status: "none", content: "", ...base } };
  return {
    result: {
      status: "comment",
      content: parsed.content,
      target: { uin: target.uin, tid: target.tid, nickname: target.nickname, excerpt: target.excerpt },
      ...base,
    },
  };
}

/** 宽松 JSON 解析：模型偶尔会在 JSON 外面裹说明文字。 */
function parseJson(reply: string): unknown {
  const text = (reply ?? "").trim();
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

/**
 * 拉取空间主动问需要的素材：她最近的长期记忆 + 朋友最近的说说。
 *
 * 记忆只取高重要度 + 新鲜的几条；朋友说说按连接里的名单拉（失败静默降级成空 ——
 * 抓不到朋友的说说她还能发自己的说说，不该因此整轮失败）。
 */
export async function collectQzoneAutoMaterials(input: {
  characterId: string;
  connectionId: string;
  scopeId: string;
  qzoneFriendQqs: string[];
  accountQq: string;
  config: { wsUrl: string; httpUrl: string; accessToken?: string; httpToken?: string };
}): Promise<{ memories: string[]; friendMoods: QzoneFeed[] }> {
  const prisma = getPrisma();

  const rows = await prisma.memoryItem.findMany({
    where: { memoryScopeId: input.scopeId, status: "ACTIVE", deletedAt: null },
    orderBy: [{ importance: "desc" }, { updatedAt: "desc" }],
    take: 8,
    select: { category: true, content: true },
  });
  const memories = rows.map((row) => `[${row.category}] ${row.content.slice(0, 180)}`);

  let friendMoods: QzoneFeed[] = [];
  try {
    const { feeds } = await listQzoneFriendMoods(input.config, {
      uins: input.qzoneFriendQqs,
      selfUin: input.accountQq,
      perFriend: 2,
      maxFriends: 5,
    });
    friendMoods = feeds;
  } catch {
    friendMoods = [];
  }

  return { memories, friendMoods };
}

/**
 * 找出「有空间主动能力」的角色 + 连接，供 tick 遍历。
 *
 * 一个连接可能挂多个角色，这里按绑定展开成「角色 × 连接」的候选列表，
 * 每个候选里带着它所属连接的配置、好友名单、小号 QQ。
 */
export async function listQzoneAutoCandidates(): Promise<Array<{
  characterId: string;
  connectionId: string;
  character: AutoAskCharacter;
  scopeId: string | null;
  qzoneFriendQqs: string[];
  accountQq: string;
  qzoneAutoAskTimes: string[];
  qzoneAutoAskDailyMax: number;
  config: { wsUrl: string; httpUrl: string; accessToken?: string; httpToken?: string };
}>> {
  const prisma = getPrisma();
  const connections = await loadOnebotConnections();
  const candidates: Array<{
    characterId: string;
    connectionId: string;
    character: AutoAskCharacter;
    scopeId: string | null;
    qzoneFriendQqs: string[];
    accountQq: string;
    qzoneAutoAskTimes: string[];
    qzoneAutoAskDailyMax: number;
    config: { wsUrl: string; httpUrl: string; accessToken?: string; httpToken?: string };
  }> = [];

  for (const connection of connections) {
    if (!connection.qzoneEnabled || !connection.qzoneAutoAskEnabled || !connection.ownerQq) continue;
    // 没设时间点就不主动问：时间点是「什么时候能问」的唯一依据。
    if (!connection.qzoneAutoAskTimes.length) continue;
    for (const binding of connection.bindings) {
      const character = await prisma.character.findUnique({
        where: { id: binding.characterId },
        select: { id: true, name: true, basePrompt: true, styleExamples: true, modelConfig: true, status: true },
      });
      if (!character || character.status !== "ACTIVE") continue;
      const scope = await prisma.memoryScope.findFirst({
        where: { characterId: character.id, scopeType: "CHARACTER_GLOBAL" },
        select: { id: true },
      });
      candidates.push({
        characterId: character.id,
        connectionId: connection.id,
        character: {
          id: character.id,
          name: character.name,
          basePrompt: character.basePrompt,
          styleExamples: character.styleExamples ?? "",
          modelConfig: character.modelConfig,
        },
        scopeId: scope?.id ?? null,
        qzoneFriendQqs: connection.qzoneFriendQqs,
        accountQq: connection.accountQq,
        qzoneAutoAskTimes: connection.qzoneAutoAskTimes,
        qzoneAutoAskDailyMax: connection.qzoneAutoAskDailyMax,
        config: connection.config,
      });
    }
  }
  return candidates;
}

export type QzoneAutoTickResult = {
  characterId: string;
  characterName: string;
  status: "asked" | "skipped" | "failed";
  reason: string;
  actionId?: string;
  content?: string;
};

const QZONE_AUTO_REASON_LABELS: Record<string, string> = {
  qzone_disabled: "空间功能没开",
  auto_ask_disabled: "空间主动没开",
  no_owner: "没填主人 QQ",
  no_binding: "没有活动绑定",
  no_memory_scope: "这个角色还没有记忆空间",
  no_recipient: "没有可发的 QQ 私聊",
  model_error: "模型调用失败",
  quota_exceeded: "今天的模型额度用完了",
  none: "她这轮没有想发的",
  pending_exists: "已经有一条待确认的空间动作",
  not_scheduled: "没到设定的时间点",
  daily_limit: "今天已经问够次数了",
  ok: "已经问她同不同意了",
};

export function describeQzoneAutoReason(reason: string): string {
  return QZONE_AUTO_REASON_LABELS[reason] ?? reason;
}

/**
 * 跑一轮「空间主动」tick：让开了开关的角色自己想一条说说 / 评论，
 * 想好了就落草稿、私信问主人「行吗」。
 *
 * 一次只处理一个候选（第一个过了闸门、且有产出的那个），和 `proactive.ts` 一样：
 * 「一次 tick 只花一次模型调用」，避免把每个角色都问一遍、把主人淹没。
 *
 * 防打扰靠两条：
 * 1. 每个连接同一 kind 同时只允许一条 PENDING 草稿（`createPendingQzoneAction` 自己会取消旧的）；
 * 2. 下面在问之前先查有没有待确认的，有就跳过 —— 主人还没回上一句，就别再问第二句。
 */
export async function runQzoneAutoTick(): Promise<QzoneAutoTickResult[]> {
  const prisma = getPrisma();
  const candidates = await listQzoneAutoCandidates();
  const results: QzoneAutoTickResult[] = [];

  for (const candidate of candidates) {
    const skip = (reason: string): QzoneAutoTickResult =>
      ({ characterId: candidate.characterId, characterName: candidate.character.name, status: "skipped", reason });

    if (!candidate.scopeId) {
      results.push(skip("no_memory_scope"));
      continue;
    }

    // 没到点就不问：主动问只在固定时间点发生，不是每 60 秒都考虑一次。
    if (!isQzoneAutoAskTime(new Date(), candidate.qzoneAutoAskTimes)) {
      results.push(skip("not_scheduled"));
      continue;
    }

    // 今天已经问够了就不问：`qzoneAutoAskDailyMax` 是跨所有时间点的当日总上限。
    const askedToday = await countQzoneAutoAskedToday(candidate.connectionId);
    if (candidate.qzoneAutoAskDailyMax > 0 && askedToday >= candidate.qzoneAutoAskDailyMax) {
      results.push(skip("daily_limit"));
      continue;
    }

    // 已经有一条待确认的（无论 POST 还是 COMMENT），这轮不问新的 —— 等主人回。
    const [pendingPost, pendingComment] = await Promise.all([
      findPendingQzoneAction(candidate.connectionId, "POST"),
      findPendingQzoneAction(candidate.connectionId, "COMMENT"),
    ]);
    if (pendingPost || pendingComment) {
      results.push(skip("pending_exists"));
      continue;
    }

    // 收件人：最近一次 QQ 私聊的对方（即主人）。没聊过就不主动开口。
    const target = await findDeliveryTarget(candidate.characterId);
    if (!target) {
      results.push(skip("no_recipient"));
      continue;
    }

    const materials = await collectQzoneAutoMaterials({
      characterId: candidate.characterId,
      connectionId: candidate.connectionId,
      scopeId: candidate.scopeId,
      qzoneFriendQqs: candidate.qzoneFriendQqs,
      accountQq: candidate.accountQq,
      config: candidate.config,
    });

    const { result, error } = await generateQzoneAutoAsk({
      character: candidate.character,
      friendMoods: materials.friendMoods,
      memories: materials.memories,
    });

    if (error === "model_not_configured" || error === "quota_exceeded" || error?.startsWith("model")) {
      results.push({
        characterId: candidate.characterId,
        characterName: candidate.character.name,
        status: "failed",
        reason: error === "quota_exceeded" ? "quota_exceeded" : "model_error",
      });
      continue;
    }
    if (result.status === "none") {
      results.push(skip("none"));
      continue;
    }

    // 落草稿 → 私信问主人。content 已在 generate 里截断，这里直接入库。
    let pending;
    if (result.status === "post") {
      pending = await createPendingQzoneAction({
        connectionId: candidate.connectionId,
        characterId: candidate.characterId,
        kind: "POST",
        content: result.content,
        topic: "主动想发的说说",
        requestedBy: target.userId,
        conversationKey: `c:${target.userId}`,
      });
      const message = [
        "我想发一条说说：",
        "",
        result.content,
        "",
        `回复「确认发说说」我就发，回别的就当我没提。`,
      ].join("\n");
      await sendOnebotPrivateMessage(target.config, target.userId, message);
    } else {
      const commentTarget = result.target!;
      pending = await createPendingQzoneAction({
        connectionId: candidate.connectionId,
        characterId: candidate.characterId,
        kind: "COMMENT",
        content: result.content,
        topic: "主动想评论朋友说说",
        requestedBy: target.userId,
        conversationKey: `c:${target.userId}`,
        targetUin: commentTarget.uin,
        targetTid: commentTarget.tid,
        targetExcerpt: `${commentTarget.nickname}：${commentTarget.excerpt.slice(0, 80)}`,
      });
      const message = [
        `我想评论 ${commentTarget.nickname} 的说说「${commentTarget.excerpt.slice(0, 40)}…」，评论写的是：`,
        "",
        result.content,
        "",
        `回复「确认评论」我就发，回别的就当我没提。`,
      ].join("\n");
      await sendOnebotPrivateMessage(target.config, target.userId, message);
    }

    results.push({
      characterId: candidate.characterId,
      characterName: candidate.character.name,
      status: "asked",
      reason: "ok",
      actionId: pending.id,
      content: result.content,
    });
  }

  return results;
}
