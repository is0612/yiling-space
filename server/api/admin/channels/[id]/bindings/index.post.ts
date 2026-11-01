import { createError, getRouterParam, readBody } from "h3";
import type { Prisma } from "../../../../../../src/generated/prisma/client";
import { requireAdminActor } from "../../../../../utils/auth";
import { isGroupId } from "../../../../../utils/channel-adapter/onebot/group-chat";
import { readTrimmedString, requireUuid } from "../../../../../utils/local-api";
import { formatClockMinutes, readClockMinutes } from "../../../../../utils/proactive-settings";
import { getPrisma } from "../../../../../utils/prisma";

/**
 * 规范化路由键：现在支持一个绑定挂多个群号。接收三种形态，统一存成逗号分隔的字符串：
 * - 字符串 "12345" 或 "12345,67890"
 * - 字符串数组 ["12345", "67890"]
 * - 空 / 空数组 / 全空 → null（表示默认绑定，收所有群 + 私聊）
 */
function normalizeRoutingKey(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  let parts: string[];
  if (Array.isArray(raw)) {
    parts = raw.map((item) => String(item ?? "").trim()).filter((item) => item.length > 0);
  } else if (typeof raw === "string") {
    parts = raw
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  } else {
    throw createError({ statusCode: 400, statusMessage: "路由键必须是字符串或字符串数组。" });
  }
  if (parts.length === 0) return null;
  const joined = [...new Set(parts)].join(",");
  if (joined.length > 255) {
    throw createError({ statusCode: 400, statusMessage: "路由键（多个群号合计）最多 255 个字符。" });
  }
  return joined;
}

/**
 * Binds a character to a QQ connection. An optional routingKey limits the binding to one or more
 * group openids (comma-separated); when omitted the binding is the connection's default
 * (receives any group event).
 */
export default defineEventHandler(async (event) => {
  const admin = await requireAdminActor(event);
  const connectionId = requireUuid(getRouterParam(event, "id") ?? "", "渠道连接");
  const body = await readBody<Record<string, unknown>>(event);

  const characterId = requireUuid(readTrimmedString(body?.characterId, "角色", 100, { required: true }), "角色");
  const routingKey = normalizeRoutingKey(body?.routingKey);

  let replyWindowMinutes: number | undefined;
  if (body?.replyWindowMinutes !== undefined) {
    const value = body.replyWindowMinutes;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1440) {
      throw createError({ statusCode: 400, statusMessage: "限流窗口必须是 1 到 1440 分钟的整数。" });
    }
    replyWindowMinutes = value;
  }
  let replyLimitPerWindow: number | undefined;
  if (body?.replyLimitPerWindow !== undefined) {
    const value = body.replyLimitPerWindow;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
      throw createError({ statusCode: 400, statusMessage: "窗口内回复上限必须是 0 到 100 的整数。" });
    }
    replyLimitPerWindow = value;
  }
  // 兼容旧客户端：replyLimitPer10Min 等价于窗口 10 分钟。
  if (body?.replyLimitPer10Min !== undefined) {
    const value = body.replyLimitPer10Min;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
      throw createError({ statusCode: 400, statusMessage: "每 10 分钟回复上限必须是 0 到 100 的整数。" });
    }
    replyLimitPerWindow = value;
    replyWindowMinutes = 10;
  }
  // 群聊回复策略 + 刷 B站：都是可选的 boolean，未提交 = 保留原值（或沿用连接默认值）。
  let replyOnlyWhenMentioned: boolean | undefined;
  if (body?.replyOnlyWhenMentioned !== undefined) {
    if (typeof body.replyOnlyWhenMentioned !== "boolean") {
      throw createError({ statusCode: 400, statusMessage: "「仅被 @ 时回复」必须是布尔值。" });
    }
    replyOnlyWhenMentioned = body.replyOnlyWhenMentioned;
  }
  // 群聊「自然接话」：模式 + 几个闸门参数。全都可以单独提交，没提交的保留原值。
  let groupChatMode: "mention" | "ambient" | "all" | undefined;
  if (body?.groupChatMode !== undefined) {
    const value = body.groupChatMode;
    if (value !== "mention" && value !== "ambient" && value !== "all") {
      throw createError({ statusCode: 400, statusMessage: "群聊回复方式只能是「仅 @ 时回复」「自然接话」或「所有消息都回复」。" });
    }
    groupChatMode = value;
  }
  const readRange = (key: string, label: string, min: number, max: number, integer = true) => {
    const raw = body?.[key];
    if (raw === undefined) return undefined;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min || raw > max || (integer && !Number.isInteger(raw))) {
      throw createError({ statusCode: 400, statusMessage: `${label}必须在 ${min} 到 ${max} 之间${integer ? "的整数" : ""}。` });
    }
    return raw;
  };
  const minGapSeconds = readRange("minGapSeconds", "最短回复间隔", 0, 3600);
  const dailyMax = readRange("dailyMax", "每天最多说几句", 0, 1000);
  const ambientChance = readRange("ambientChance", "无关闲聊的参与概率", 0, 1, false);
  const readClockField = (key: string, label: string) => {
    const raw = body?.[key];
    if (raw === undefined) return undefined;
    const minutes = readClockMinutes(raw);
    if (minutes === null) throw createError({ statusCode: 400, statusMessage: `${label}必须是 HH:MM 格式的时间。` });
    return formatClockMinutes(minutes);
  };
  const quietStart = readClockField("quietStart", "安静时段起点");
  const quietEnd = readClockField("quietEnd", "安静时段终点");
  let groupAliases: string | undefined;
  if (body?.groupAliases !== undefined) {
    if (typeof body.groupAliases !== "string") {
      throw createError({ statusCode: 400, statusMessage: "群里的称呼必须是逗号分隔的文字。" });
    }
    const trimmed = body.groupAliases.trim();
    if (trimmed.length > 200) {
      throw createError({ statusCode: 400, statusMessage: "群里的称呼最多 200 个字。" });
    }
    groupAliases = trimmed;
  }

  let groupBiliRunEnabled: boolean | undefined;
  if (body?.groupBiliRunEnabled !== undefined) {
    if (typeof body.groupBiliRunEnabled !== "boolean") {
      throw createError({ statusCode: 400, statusMessage: "「刷一轮 B站」必须是布尔值。" });
    }
    groupBiliRunEnabled = body.groupBiliRunEnabled;
  }

  /**
   * 按群覆盖的群聊模式：`{ "<群号>": "mention" | "ambient" | "all" }`。
   *
   * 一条绑定挂多个群时，不同群的「存在感」经常不一样（大群只看被 @，小群随便聊）。
   * 传 `{}` 或 `null` = 全部清除、回到绑定统一那一档。写入侧严格校验，不做静默丢弃 ——
   * 静默丢一个群号，用户只会觉得「我明明设了它却不生效」。
   */
  let groupChatModes: Record<string, "mention" | "ambient" | "all"> | undefined;
  if (body?.groupChatModes !== undefined) {
    const raw = body.groupChatModes;
    if (raw === null) {
      groupChatModes = {};
    } else if (typeof raw !== "object" || Array.isArray(raw)) {
      throw createError({ statusCode: 400, statusMessage: "按群设置必须是「群号 → 模式」的对象。" });
    } else {
      const entries = Object.entries(raw as Record<string, unknown>);
      if (entries.length > 50) {
        throw createError({ statusCode: 400, statusMessage: "按群设置最多 50 个群。" });
      }
      const validated: Record<string, "mention" | "ambient" | "all"> = {};
      for (const [key, value] of entries) {
        const groupId = key.trim();
        if (!isGroupId(groupId)) {
          throw createError({ statusCode: 400, statusMessage: `群号「${groupId}」格式不对（应为纯数字）。` });
        }
        if (value !== "mention" && value !== "ambient" && value !== "all") {
          throw createError({ statusCode: 400, statusMessage: `群 ${groupId} 的模式无效。` });
        }
        validated[groupId] = value;
      }
      groupChatModes = validated;
    }
  }

  const prisma = getPrisma();
  const connection = await prisma.platformConnection.findUnique({
    where: { id: connectionId },
    select: { id: true },
  });
  if (!connection) throw createError({ statusCode: 404, statusMessage: "渠道连接不存在。" });

  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId: admin.user.id },
    select: { id: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在或不属于当前账号。" });

  const existing = await prisma.characterChannelBinding.findUnique({
    where: { characterId_connectionId: { characterId, connectionId } },
    select: { config: true },
  });
  const baseConfig = (existing?.config && typeof existing.config === "object" && !Array.isArray(existing.config))
    ? existing.config as Record<string, unknown>
    : {};
  // 未提交任何行为字段时保留原配置：重新绑定时不能把已有群规悄悄清掉。
  const patch: Record<string, unknown> = {};
  if (replyWindowMinutes !== undefined) patch.replyWindowMinutes = replyWindowMinutes;
  if (replyLimitPerWindow !== undefined) patch.replyLimitPerWindow = replyLimitPerWindow;
  if (groupChatMode !== undefined) {
    patch.groupChatMode = groupChatMode;
    // 旧字段跟新字段保持一致：两个都存着但说法不同，下一个读代码的人一定会踩。
    patch.replyOnlyWhenMentioned = groupChatMode === "mention";
  } else if (replyOnlyWhenMentioned !== undefined) {
    // 老客户端只认识这个开关：关 = 自然接话（不是「全都回」，那个要显式选 all）。
    patch.replyOnlyWhenMentioned = replyOnlyWhenMentioned;
    patch.groupChatMode = replyOnlyWhenMentioned ? "mention" : "ambient";
  }
  if (minGapSeconds !== undefined) patch.minGapSeconds = minGapSeconds;
  if (dailyMax !== undefined) patch.dailyMax = dailyMax;
  if (ambientChance !== undefined) patch.ambientChance = ambientChance;
  if (quietStart !== undefined) patch.quietStart = quietStart;
  if (quietEnd !== undefined) patch.quietEnd = quietEnd;
  if (groupAliases !== undefined) patch.groupAliases = groupAliases;
  if (groupBiliRunEnabled !== undefined) patch.groupBiliRunEnabled = groupBiliRunEnabled;
  if (groupChatModes !== undefined) patch.groupChatModes = groupChatModes;
  const hasUpdate = Object.keys(patch).length > 0;
  let config = hasUpdate ? { ...baseConfig, ...patch } : (existing?.config ?? undefined);
  // 空表不留在库里：留个 `{}` 会让「有没有按群设过」变得难判断，读的时候还要再多想一层。
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const cleaned = { ...(config as Record<string, unknown>) };
    if (cleaned.groupChatModes && typeof cleaned.groupChatModes === "object"
      && Object.keys(cleaned.groupChatModes as Record<string, unknown>).length === 0) {
      delete cleaned.groupChatModes;
    }
    config = cleaned;
  }
  const configForWrite = config as Prisma.InputJsonObject | undefined;
  const binding = await prisma.characterChannelBinding.upsert({
    where: { characterId_connectionId: { characterId, connectionId } },
    create: { characterId, connectionId, status: "ACTIVE", routingKey, ...(configForWrite ? { config: configForWrite } : {}) },
    update: {
      status: "ACTIVE",
      routingKey,
      ...(hasUpdate && configForWrite ? { config: configForWrite } : {}),
    },
    select: { id: true, characterId: true, connectionId: true, routingKey: true, config: true },
  });

  return binding;
});
