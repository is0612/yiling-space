import { parseJsonLoose } from "./loose-json";
import { randomUUID, createHash } from "node:crypto";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { resolveChatModelSettings } from "./chat-model-config";
import { resolveCharacterApiKey } from "./credential-encryption";
import { readDailyQuota, recordModelUsage } from "./model-usage";
import { callRawModel } from "./raw-llm";
import { interactionExperiencePrompt, parseInteractionSuggestion } from "./interaction-experiences";
const hash = (a: {
    content: string;
    occurredAt: Date;
}, f: {
    content: string;
    occurredAt: Date;
}, scope: string) => createHash("sha256").update(JSON.stringify([a.content, a.occurredAt.toISOString(), f.content, f.occurredAt.toISOString(), scope])).digest("hex");
/** Persistent request-independent checkpoints. One claimed room per Worker round. */
export async function processAutomaticInteractionExperience(prisma: PrismaClient, now = new Date()) {
    const activation = await prisma.interactionExperienceActivation.findUnique({ where: { id: 1 } });
    if (!activation)
        return { processed: false };
    const known = await prisma.interactionExperienceProgress.findMany({ select: { conversationId: true } });
    const rooms = await prisma.conversation.findMany({ where: { id: { notIn: known.map(row => row.conversationId) }, character: { modelConfig: { path: ["interactionExperienceAutoEnabled"], equals: true } }, OR: [{ channelBindingId: null }, { externalConversationId: { startsWith: "c:" } }], messages: { some: { occurredAt: { gte: activation.anchorAt } } } }, select: { id: true }, take: 50, orderBy: { updatedAt: "asc" } });
    for (const room of rooms)
        await prisma.interactionExperienceProgress.upsert({ where: { conversationId: room.id }, create: { conversationId: room.id, anchorAt: activation.anchorAt, runAt: now }, update: {} });
    const candidates = await prisma.interactionExperienceProgress.findMany({ where: { runAt: { lte: now }, OR: [{ status: { not: "RUNNING" } }, { leaseUntil: { lt: now } }] }, orderBy: { runAt: "asc" }, take: 20 });
    for (const progress of candidates) {
        const room = await prisma.conversation.findFirst({ where: { id: progress.conversationId, character: { modelConfig: { path: ["interactionExperienceAutoEnabled"], equals: true } }, OR: [{ channelBindingId: null }, { externalConversationId: { startsWith: "c:" } }] }, include: { character: true } });
        const defer = () => prisma.interactionExperienceProgress.updateMany({ where: { conversationId: progress.conversationId, updatedAt: progress.updatedAt }, data: { runAt: new Date(now.getTime() + 300000), updatedAt: new Date() } });
        if (!room) {
            await defer();
            continue;
        }
        const rows = await prisma.message.findMany({ where: { conversationId: room.id, role: { in: ["USER", "ASSISTANT"] }, occurredAt: { gte: progress.anchorAt }, ...(progress.cursorAt ? { OR: [{ occurredAt: { gt: progress.cursorAt } }, { occurredAt: progress.cursorAt, id: { gt: progress.cursorId! } }] } : {}) }, orderBy: [{ occurredAt: "asc" }, { id: "asc" }], take: 41 });
        if (!rows.length) {
            await defer();
            continue;
        }
        const last = rows[rows.length - 1]!;
        if (rows.length < 40 && now.getTime() - last.occurredAt.getTime() < 30 * 60000) {
            await defer();
            continue;
        }
        // Keep the last message as overlap at a size boundary; its eventual feedback is not lost.
        let batch = rows.length >= 40 ? rows.slice(0, 39) : rows;
        let chars = 0;
        let count = 0;
        for (const row of batch) {
            if (count && chars + row.content.length > 24000)
                break;
            chars += row.content.length;
            count++;
        }
        batch = batch.slice(0, count);
        const end = batch[batch.length - 1]!;
        const token = randomUUID();
        const claimed = await prisma.interactionExperienceProgress.updateMany({ where: { conversationId: room.id, updatedAt: progress.updatedAt, OR: [{ status: { not: "RUNNING" } }, { leaseUntil: { lt: now } }] }, data: { status: "RUNNING", token, leaseUntil: new Date(now.getTime() + 300000), updatedAt: now } });
        if (!claimed.count)
            continue;
        try {
            const prior = progress.cursorAt ? await prisma.message.findFirst({ where: { conversationId: room.id, role: "ASSISTANT", occurredAt: { gte: progress.anchorAt }, OR: [{ occurredAt: { lt: progress.cursorAt } }, { occurredAt: progress.cursorAt, id: { lte: progress.cursorId! } }] }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }] }) : null;
            const preceding = await prisma.message.findMany({ where: { conversationId: room.id, occurredAt: { gte: progress.anchorAt }, OR: [{ occurredAt: { lt: batch[0]!.occurredAt } }, { occurredAt: batch[0]!.occurredAt, id: { lt: batch[0]!.id } }], role: { in: ["USER", "ASSISTANT"] } }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 8 });
            let contextChars = 0;
            const contextRows = preceding.filter(row => { if (contextChars + row.content.length > 4000) return false; contextChars += row.content.length; return true; }).reverse();
            const pairs: Array<{
                assistant: typeof end;
                feedback: typeof end;
            }> = [];
            let assistant: typeof end | undefined = prior ?? undefined;
            for (const message of batch) {
                if (message.role === "ASSISTANT")
                    assistant = message;
                else if (assistant)
                    pairs.push({ assistant, feedback: message });
            }
            const eligible = [];
            for (const pair of pairs) {
                if (pair.assistant.content.length + pair.feedback.content.length > 16000)
                    continue;
                const exists = await prisma.interactionExperience.findUnique({ where: { conversationId_assistantMessageId_feedbackMessageId: { conversationId: room.id, assistantMessageId: pair.assistant.id, feedbackMessageId: pair.feedback.id } } });
                if (!exists)
                    eligible.push(pair);
            }
            const drafts: Array<{
                pair: typeof pairs[number];
                suggestion: ReturnType<typeof parseInteractionSuggestion>;
            }> = [];
            if (eligible.length) {
                const settings = resolveChatModelSettings(room.character.modelConfig);
                const key = await resolveCharacterApiKey(room.character.modelConfig, settings.apiBaseUrl);
                if (!key || !settings.model || (await readDailyQuota(room.characterId, room.character.modelConfig)).exceeded)
                    throw new Error("MODEL_UNAVAILABLE");
                const text = await callRawModel({ model: settings.model, apiKey: key, apiBaseUrl: settings.apiBaseUrl, systemPrompt: interactionExperiencePrompt + ' 自动批量模式优先：messages含原始请求与前文，pairs仅允许指定回复和反馈ID；contextOnly消息只用于理解不能独立形成经验。仅输出{ "experiences": [{ "assistantMessageId":"输入ID", "feedbackMessageId":"输入ID", "content":"经验", "context":"场景", "feedbackQuote":"原文", "learning":{"kind":"UNDERSTANDING|REFERENCE|SITUATION|STRATEGY|EXPRESSION","situation":"当时情境","misunderstanding":"误解或空字符串","correction":"用户支持的纠正","nextJudgment":"下次判断"}}]}，没有合格项返回空数组，最多3条。不要输出单项skip对象。', userPrompt: JSON.stringify({ pairs: eligible.map(p => ({ assistantMessageId: p.assistant.id, feedbackMessageId: p.feedback.id })), messages: [...new Map([...contextRows, ...batch, ...eligible.flatMap(p => [p.assistant, p.feedback])].filter(m => m.content.length <= 16000).map(m => [m.id, {id:m.id,role:m.role,content:m.content,contextOnly:contextRows.some(row=>row.id===m.id)}])).values()].slice(-48) }), onUsage: usage => { void recordModelUsage({ characterId: room.characterId, conversationId: room.id, model: settings.model, kind: "other", usage, metadata: { source: "interaction-experience-auto" } }).catch(() => undefined); } });
                const parsed = parseJsonLoose(text, { expect: "object" }) as {
                    experiences?: unknown[];
                };
                if (!Array.isArray(parsed?.experiences))
                    throw new Error("MODEL_FAILED");
                for (const raw of parsed.experiences.slice(0, 3)) {
                    const r = raw as Record<string, unknown>;
                    const pair = eligible.find(p => p.assistant.id === r.assistantMessageId && p.feedback.id === r.feedbackMessageId);
                    if (!pair)
                        throw new Error("MODEL_FAILED");
                    const suggestion = parseInteractionSuggestion(JSON.stringify(r), pair.feedback.content);
                    if (!("skip" in suggestion) && !suggestion.learning) throw new Error("MODEL_FAILED");
                    drafts.push({ pair, suggestion });
                }
            }
            await prisma.$transaction(async (tx) => {
                // Updating the fenced row locks it until both experiences and cursor commit.
                const locked = await tx.interactionExperienceProgress.updateMany({ where: { conversationId: room.id, token, status: "RUNNING", leaseUntil: { gte: new Date() } }, data: { updatedAt: new Date() } });
                if (!locked.count)
                    throw new Error("LEASE_LOST");
                const current = await tx.conversation.findFirst({ where: { id: room.id, characterId: room.characterId, memoryScopeId: room.memoryScopeId, character: { modelConfig: { path: ["interactionExperienceAutoEnabled"], equals: true } } } });
                if (!current)
                    throw new Error("SOURCE_CHANGED");
                const reloaded = await tx.message.findMany({ where: { conversationId: room.id, id: { in: [...batch, ...contextRows].map(row => row.id) } }, orderBy: [{ occurredAt: "asc" }, { id: "asc" }] });
                const evidenceHash = (messages: typeof batch) => createHash("sha256").update(JSON.stringify(messages.map(m => [m.id, m.role, m.content, m.occurredAt.toISOString()]))).digest("hex");
                if (evidenceHash(reloaded) !== evidenceHash([...contextRows, ...batch]))
                    throw new Error("SOURCE_CHANGED");
                for (const { pair, suggestion } of drafts) {
                    const source = await tx.message.findMany({ where: { id: { in: [pair.assistant.id, pair.feedback.id] }, conversationId: room.id } });
                    const a = source.find(m => m.id === pair.assistant.id), f = source.find(m => m.id === pair.feedback.id);
                    if (!a || !f || hash(a, f, room.memoryScopeId) !== hash(pair.assistant, pair.feedback, room.memoryScopeId))
                        throw new Error("SOURCE_CHANGED");
                    if ("skip" in suggestion)
                        continue;
                    await tx.interactionExperience.upsert({ where: { conversationId_assistantMessageId_feedbackMessageId: { conversationId: room.id, assistantMessageId: a.id, feedbackMessageId: f.id } }, update: {}, create: { characterId: room.characterId, conversationId: room.id, memoryScopeId: room.memoryScopeId, assistantMessageId: a.id, feedbackMessageId: f.id, evidenceHash: hash(a, f, room.memoryScopeId), status: "ACTIVE", ...suggestion } });
                }
                await tx.auditLog.create({ data: { actorType: "SYSTEM", characterId: room.characterId, action: "interaction_experience.auto_completed", entityType: "Conversation", entityId: room.id, details: { generated: drafts.length, cursorMessageId: end.id } } });
                await tx.interactionExperienceProgress.update({ where: { conversationId: room.id }, data: { cursorAt: end.occurredAt, cursorId: end.id, status: "SUCCEEDED", token: null, leaseUntil: null, attempts: 0, lastError: null, runAt: new Date(now.getTime() + 300000), updatedAt: new Date() } });
            });
            return { processed: true, status: "SUCCEEDED", pairs: drafts.length };
        }
        catch (error) {
            const code = error instanceof Error && ["MODEL_UNAVAILABLE", "LEASE_LOST", "SOURCE_CHANGED"].includes(error.message) ? error.message : "MODEL_FAILED";
            await prisma.interactionExperienceProgress.updateMany({ where: { conversationId: room.id, token, status: "RUNNING" }, data: { status: "RETRY_WAIT", token: null, leaseUntil: null, attempts: { increment: 1 }, lastError: code, runAt: new Date(now.getTime() + 300000), updatedAt: new Date() } });
            return { processed: true, status: "RETRY_WAIT", reason: code };
        }
    }
    return { processed: false };
}
