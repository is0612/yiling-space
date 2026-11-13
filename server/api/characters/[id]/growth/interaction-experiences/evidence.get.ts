import { interactionReadableScope } from "../../../../../utils/interaction-experiences";
import { getQuery, getRouterParam, createError } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
export default defineEventHandler(async event => {
 const ownerId = await requireActorUserId(event); const characterId = requireUuid(getRouterParam(event,"id") ?? "", "角色"); const prisma = getPrisma();
 if (!await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id:true } })) throw createError({statusCode:404,statusMessage:"角色不存在。"});
 const query = getQuery(event);
 if (!query.conversationId) return { conversations: await prisma.conversation.findMany({where:{characterId,memoryScope:interactionReadableScope(ownerId)},select:{id:true,title:true,memoryScopeId:true},orderBy:{updatedAt:"desc"},take:50}) };
 const conversationId = requireUuid(String(query.conversationId),"会话");
 return { messages: await prisma.message.findMany({where:{conversationId,conversation:{characterId,memoryScope:interactionReadableScope(ownerId)},role:{in:["USER","ASSISTANT"]}},select:{id:true,role:true,content:true,occurredAt:true},orderBy:[{occurredAt:"desc"},{id:"desc"}],take:100}) };
});
