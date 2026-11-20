import { createHash } from "node:crypto";
import { createError } from "h3";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { getPrisma } from "./prisma";
import * as roleplay from "./roleplay-service";

const HELP = "扮演命令：\n/扮演 列表\n/扮演 开始 人设编号或名称（新建存档）\n/扮演 存档\n/扮演 继续 存档编号\n/扮演 状态\n/扮演 退出\n退出保留存档，回到日常聊天。";
export type RoleplayCommand = { action: "help" | "list" | "start" | "sessions" | "resume" | "status" | "exit"; target: string };
export function parseRoleplayCommand(content: string): RoleplayCommand | null {
  const match = /^\/扮演(?:\s+([\s\S]*))?$/u.exec(content.trim());
  if (!match) return null;
  const text = (match[1] ?? "").trim();
  const split = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(text);
  const verb = split?.[1] ?? "";
  const target = (split?.[2] ?? "").trim();
  const verbs: Record<string, RoleplayCommand["action"]> = { 列表: "list", 开始: "start", 开启: "start", 存档: "sessions", 继续: "resume", 状态: "status", 退出: "exit", 帮助: "help" };
  const action = verbs[verb] ?? "help";
  if (!["start", "resume"].includes(action) && target) return { action: "help", target: "" };
  return { action, target };
}
export function resolveRoleplayTarget<T extends { id: string; name?: string; title?: string }>(items: T[], target: string): T | null {
  if (!target) return null;
  const exact = items.filter(item => item.id === target || item.name === target || item.title === target);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1 || !/^[a-f0-9-]{8,36}$/iu.test(target)) return null;
  const prefix = items.filter(item => item.id.toLowerCase().startsWith(target.toLowerCase()));
  return prefix.length === 1 ? prefix[0]! : null;
}
export function isRoleplayOwner(input: { platform: string; eventType: string; authorUid: string; conversationKey: string }, binding: { characterId: string; status: string; connection: { platform: string; metadata: unknown }; character: { status: string } }, characterId: string): boolean {
  const metadata = binding.connection.metadata as Record<string, unknown> | null;
  const owner = typeof metadata?.ownerQq === "string" ? metadata.ownerQq.trim() : "";
  return input.platform === "qq-onebot" && (input.eventType === "PRIVATE_MESSAGE" || input.eventType === "GROUP_MESSAGE") && binding.connection.platform === "qq-onebot"
    && binding.characterId === characterId && binding.status === "ACTIVE" && binding.character.status === "ACTIVE"
    && Boolean(owner) && owner === input.authorUid && (input.eventType === "GROUP_MESSAGE" ? /^g:[1-9][0-9]{0,19}$/.test(input.conversationKey) : input.conversationKey === `c:${input.authorUid}`);
}
export function roleplayParticipantCode(sessionId: string, authorUid: string): string {
  return `群成员_${createHash("sha256").update(JSON.stringify([sessionId, authorUid])).digest("hex").slice(0, 12)}`;
}
function requestId(bindingId: string, conversationKey: string, externalMessageId: string): string {
  const hex = createHash("sha256").update(JSON.stringify([bindingId, conversationKey, externalMessageId])).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function legacyPrivateRequestId(bindingId: string, messageId: string): string {
  const h = createHash("sha256").update(`${bindingId}:${messageId}`).digest("hex").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** Internal replay identity only; never returns raw platform identifiers or message content. */
export async function findRoleplayChannelReplay(input: Omit<RoleplayChannelInput, "sendReply">, prisma: PrismaClient = getPrisma()) {
  const group = input.eventType === "GROUP_MESSAGE";
  if (input.platform !== "qq-onebot" || (!group && input.eventType !== "PRIVATE_MESSAGE")) return null;
  const binding = await prisma.characterChannelBinding.findUnique({ where: { id: input.bindingId }, select: { characterId: true, status: true, connection: { select: { platform: true, metadata: true } }, character: { select: { ownerId: true, status: true } } } });
  if (!binding || binding.characterId !== input.characterId || binding.status !== "ACTIVE" || binding.character.status !== "ACTIVE" || binding.connection.platform !== "qq-onebot") return null;
  if (!group && !isRoleplayOwner({ platform: input.platform, eventType: input.eventType, authorUid: input.authorUid, conversationKey: input.externalConversationId }, binding, input.characterId)) return null;
  const ids = [requestId(input.bindingId, input.externalConversationId, input.externalMessageId), ...(!group ? [legacyPrivateRequestId(input.bindingId, input.externalMessageId)] : [])];
  const users = await prisma.roleplayMessage.findMany({ where: { role: "user", source: group ? "qq-group" : "qq", requestId: { in: ids }, session: { ownerId: binding.character.ownerId, ...(group ? { groupBindingId: input.bindingId, groupConversationId: input.externalConversationId } : { groupBindingId: null, groupConversationId: null }) } }, select: { sessionId: true, requestId: true, content: true } });
  const user = users.find(m => m.content === (group ? `[${roleplayParticipantCode(m.sessionId, input.authorUid)}] ${input.content}` : input.content).trim());
  if (!user) return null;
  const answer = await prisma.roleplayMessage.findFirst({ where: { sessionId: user.sessionId, requestId: user.requestId, role: "assistant" }, select: { id: true } });
  return { sessionId: user.sessionId, requestId: user.requestId!, completed: Boolean(answer) };
}
function readableError(error: unknown): string {
  const status = typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : 0;
  if (status === 409) return "这份存档正在回复，或上一条消息尚未完成。请在角色扮演页面查看并重试上一条消息。";
  if (status === 404) return "人设或存档已不存在，请用 /扮演 列表 或 /扮演 存档 重新选择。";
  return "扮演回复未完成，聊天仍保留在独立存档里。请到角色扮演页面检查模型设置并重试；也可用 /扮演 退出 回到日常聊天。";
}
export type RoleplayChannelInput = {
  platform: string; eventType: string; characterId: string; bindingId: string; externalConversationId: string;
  externalMessageId: string; authorUid: string; content: string; addressed?: boolean; sendReply: (text: string) => Promise<void>;
};
/** Called before the normal channel pipeline: no roleplay text reaches daily messages or growth. */
export async function handleRoleplayChannel(input: RoleplayChannelInput, prisma: PrismaClient = getPrisma()): Promise<{ status: "replied"; conversationId: string } | { status: "duplicate" } | { status: "ignored"; reason: string } | null> {
  const isGroup = input.eventType === "GROUP_MESSAGE";
  if (input.platform !== "qq-onebot" || (!isGroup && input.eventType !== "PRIVATE_MESSAGE")) return null;
  if (isGroup && !/^g:[1-9][0-9]{0,19}$/.test(input.externalConversationId)) return null;
  const binding = await prisma.characterChannelBinding.findUnique({
    where: { id: input.bindingId },
    select: { characterId: true, status: true, connection: { select: { platform: true, metadata: true } }, character: { select: { ownerId: true, status: true } } },
  });
  if (!binding || binding.characterId !== input.characterId || binding.status !== "ACTIVE" || binding.character.status !== "ACTIVE" || binding.connection.platform !== "qq-onebot") return null;
  const isOwner = isRoleplayOwner({ platform: input.platform, eventType: input.eventType, authorUid: input.authorUid, conversationKey: input.externalConversationId }, binding, input.characterId);
  const ownerId = binding.character.ownerId;
  const command = parseRoleplayCommand(input.content);
  const routeWhere = { bindingId_externalConversationId: { bindingId: input.bindingId, externalConversationId: input.externalConversationId } };
  const scope = isGroup ? { groupBindingId: input.bindingId, groupConversationId: input.externalConversationId } : { groupBindingId: null, groupConversationId: null };
  if (!isOwner && command) {
    if (!isGroup) {
      await input.sendReply("仅主人可切换角色扮演或查看存档。");
      return { status: "replied", conversationId: input.externalConversationId };
    }
    return { status: "ignored", reason: "roleplay_not_addressed" };
  }
  if (!isGroup && !isOwner) return null;
  if (command && isOwner) {
    let reply = "";
    try {
      reply = await prisma.$transaction(async tx => {
        // Serialize command switches even if two adapter processes receive the same event.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.bindingId}:${input.externalConversationId}`}, 0))`;
        const receipt = await tx.roleplayChannelReceipt.findUnique({ where: { bindingId_externalMessageId: { bindingId: input.bindingId, externalMessageId: requestId(input.bindingId, input.externalConversationId, input.externalMessageId) } } });
        const legacyReceipt = !isGroup && !receipt ? await tx.roleplayChannelReceipt.findUnique({ where: { bindingId_externalMessageId: { bindingId: input.bindingId, externalMessageId: input.externalMessageId } } }) : null;
        if (receipt?.ownerId === ownerId) return receipt.reply;
        if (legacyReceipt?.ownerId === ownerId) return legacyReceipt.reply;
        let text = HELP;
        if (command.action === "list") {
          const items = await tx.roleplayPersona.findMany({ where: { ownerId }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: 50 });
          text = items.length ? `扮演人设：\n${items.map(item => `${item.id.slice(0, 8)}  ${item.name}`).join("\n")}\n发送 /扮演 开始 编号 新开对话。最多显示最近50项，完整列表在网页查看。` : "还没有扮演人设，请先在角色扮演页面添加。";
        } else if (command.action === "sessions") {
          const items = await tx.roleplaySession.findMany({ where: { ownerId, ...scope }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: 30 });
          text = items.length ? `最近存档：\n${items.map(item => `${item.id.slice(0, 8)}  ${item.title}`).join("\n")}\n发送 /扮演 继续 编号。最多显示最近30份，完整列表在网页查看。` : "还没有存档，发送 /扮演 列表 选择人设。";
        } else if (command.action === "exit") {
          const removed = await tx.roleplayRoute.deleteMany({ where: { bindingId: input.bindingId, externalConversationId: input.externalConversationId, ownerId } });
          text = removed.count ? "已退出扮演，存档已保留。现在回到日常聊天。" : "现在是日常聊天，没有正在使用的扮演存档。";
        } else if (command.action === "status") {
          const route = await tx.roleplayRoute.findUnique({ where: routeWhere, include: { session: true } });
          text = route?.ownerId === ownerId && route.characterId === input.characterId && route.session.groupBindingId === scope.groupBindingId && route.session.groupConversationId === scope.groupConversationId ? `正在扮演：${route.session.title}\n存档：${route.sessionId.slice(0, 8)}\n退出：/扮演 退出` : "现在是日常聊天。发送 /扮演 列表 查看人设。";
        } else if (command.action === "start" || command.action === "resume") {
          if (!command.target) text = HELP;
          else {
            let session;
            if (command.action === "start") {
              const personas = await tx.roleplayPersona.findMany({ where: { ownerId } });
              const persona = resolveRoleplayTarget(personas, command.target);
              if (!persona) text = "没有唯一匹配的人设，请发送 /扮演 列表，使用人设编号。";
              else session = await roleplay.createRoleplaySession(ownerId, { personaId: persona.id, hostCharacterId: input.characterId, ...(isGroup ? { groupContext: { bindingId: input.bindingId, conversationId: input.externalConversationId } } : {}) }, tx);
            } else {
              const sessions = await tx.roleplaySession.findMany({ where: { ownerId, ...scope }, select: { id: true, title: true } });
              const selected = resolveRoleplayTarget(sessions, command.target);
              if (!selected) text = "没有唯一匹配的存档，请发送 /扮演 存档，使用存档编号。";
              else session = await tx.roleplaySession.findFirst({ where: { ownerId, id: selected.id, ...scope } });
            }
            if (session) {
              const data = { ownerId, userId: ownerId, characterId: input.characterId, sessionId: session.id };
              await tx.roleplayRoute.upsert({ where: routeWhere, create: { ...data, bindingId: input.bindingId, externalConversationId: input.externalConversationId }, update: data });
              text = `已${command.action === "start" ? "开始" : "继续"}扮演：${session.title}\n存档：${session.id.slice(0, 8)}\n接下来的消息只进入这份存档。退出：/扮演 退出`;
            }
          }
        }
        await tx.roleplayChannelReceipt.create({ data: { ownerId, bindingId: input.bindingId, externalMessageId: requestId(input.bindingId, input.externalConversationId, input.externalMessageId), reply: text } });
        return text;
      }, { timeout: 20_000 });
    } catch (error) {
      // A command failure is never reinterpreted as ordinary daily conversation.
      if (error && typeof error === "object" && "code" in error && error.code === "P2021") throw createError({ statusCode: 503, statusMessage: "请先应用角色扮演数据库迁移。" });
      reply = readableError(error);
    }
    await input.sendReply(reply);
    return { status: "replied", conversationId: input.externalConversationId };
  }
  const route = await prisma.roleplayRoute.findUnique({ where: routeWhere, include: { session: { select: { groupBindingId: true, groupConversationId: true } } } });
  const replay = await findRoleplayChannelReplay(input, prisma);
  if (replay && replay.sessionId !== route?.sessionId) return { status: "duplicate" };
  if (!route) return null;
  if (isGroup && input.addressed !== true) return { status: "ignored", reason: "roleplay_not_addressed" };
  const scopeMatches = isGroup
    ? route.session.groupBindingId === input.bindingId && route.session.groupConversationId === input.externalConversationId
    : route.session.groupBindingId === null && route.session.groupConversationId === null;
  if (!scopeMatches || route.ownerId !== ownerId || route.characterId !== input.characterId || route.userId !== ownerId) {
    await input.sendReply("扮演绑定已变更，请用 /扮演 退出 后重新选择存档。");
    return { status: "replied", conversationId: route.sessionId };
  }
  let reply: string;
  try {
    const result = await roleplay.sendMessage(ownerId, route.sessionId, { content: isGroup ? `[${roleplayParticipantCode(route.sessionId, input.authorUid)}] ${input.content}` : input.content, requestId: replay?.requestId ?? requestId(input.bindingId, input.externalConversationId, input.externalMessageId), source: isGroup ? "qq-group" : "qq" });
    reply = result.assistantMessage.content;
  } catch (error) {
    reply = readableError(error);
  }
  await input.sendReply(reply);
  return { status: "replied", conversationId: route.sessionId };
}
