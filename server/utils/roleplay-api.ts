import { createError, getQuery, getRouterParam, readBody, type H3Event } from "h3";
import { requireActorUserId } from "./auth";
import { requireUuid } from "./local-api";
import * as service from "./roleplay-service";

export async function roleplayApi(event: H3Event, operation: string) {
  const ownerId = await requireActorUserId(event);
  const id = operation.includes("Id") ? requireUuid(getRouterParam(event, "id") ?? "", "扮演记录") : "";
  const body = async (): Promise<Record<string, unknown>> => {
    const value = await readBody(event);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw createError({ statusCode: 400, statusMessage: "请求正文必须是对象。" });
    return value;
  };
  switch (operation) {
    case "getSettings": return service.getSettings(ownerId);
    case "putSettings": return service.updateSettings(ownerId, await body());
    case "listPersonas": return service.listPersonas(ownerId);
    case "postPersona": return service.createPersona(ownerId, await body());
    case "patchPersonaId": return service.updatePersona(ownerId, id, await body());
    case "deletePersonaId": return service.deletePersona(ownerId, id);
    case "listSessions": {
      const personaId = getQuery(event).personaId;
      return service.listRoleplaySessions(ownerId, personaId === undefined ? undefined : requireUuid(String(personaId), "扮演角色"));
    }
    case "postSession": {
      const b = await body();
      return service.createRoleplaySession(ownerId, { personaId: requireUuid(String(b.personaId ?? ""), "扮演角色"), ...(b.title !== undefined ? { title: String(b.title) } : {}), ...(b.hostCharacterId !== undefined ? { hostCharacterId: requireUuid(String(b.hostCharacterId), "主人格") } : {}) });
    }
    case "getSessionId": return service.getRoleplaySession(ownerId, id);
    case "patchSessionId": return service.updateRoleplaySession(ownerId, id, await body());
    case "deleteSessionId": return service.deleteSession(ownerId, id);
    case "postMessageId": {
      const b = await body();
      if (typeof b.content !== "string" || typeof b.requestId !== "string") throw createError({ statusCode: 400, statusMessage: "content 和 requestId 必须是字符串。" });
      return service.sendMessage(ownerId, id, { content: b.content, requestId: b.requestId, source: "web" });
    }
    case "applyPersonaId": return service.applyPersona(ownerId, id);
    case "compressId": return service.compressSession(ownerId, id);
    default: throw createError({ statusCode: 404 });
  }
}
