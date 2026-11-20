import { createError, getQuery, getRouterParam, setHeader } from "h3";
import { requireAdminActor } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { readLocalChatResults } from "../../../../utils/local-chat-results";

export default defineEventHandler(async event => {
  const actor = await requireAdminActor(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const { conversationId } = getQuery(event);
  if (typeof conversationId !== "string") throw createError({ statusCode: 400, message: "缺少会话 ID。" });
  setHeader(event, "Cache-Control", "no-store");
  return readLocalChatResults(actor.user.id, characterId, requireUuid(conversationId, "会话"));
});
