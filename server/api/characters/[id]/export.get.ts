import { createError, getQuery, getRouterParam, setHeader } from "h3";
import { requireActorUserId } from "../../../utils/auth";
import { characterBundleFileName } from "../../../utils/character-portable";
import { loadCharacterExportBundle } from "../../../utils/character-transfer";
import { requireUuid } from "../../../utils/local-api";

/**
 * 导出一个角色为「角色卡」JSON。
 *
 * 只带：人设、少量模型参数、角色全局记忆、**导出者自己的**私人记忆、忆泡、当前版本阶段总结、梗，
 * 以及（默认）她的朋友。
 * 不带：会话原文、他人私人记忆（其他站内用户）、渠道绑定、任务队列、用量审计、API Key、表情包图片。
 *
 * `?friends=0` 用于「要把卡发给别人」的场景：朋友段里是别人的 QQ 号和「她怎么看他们」，
 * 发出去前应当由导出者明确决定不带。读取与过滤规则在 `server/utils/character-transfer.ts`。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const now = new Date();
  const friendsParam = String(getQuery(event).friends ?? "").trim().toLowerCase();
  const includeFriends = friendsParam !== "0" && friendsParam !== "false";

  const result = await loadCharacterExportBundle({ characterId, ownerId, now, includeFriends });
  if (!result) {
    throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  }

  const fileName = characterBundleFileName(result.characterName, now);
  setHeader(event, "Content-Type", "application/json; charset=utf-8");
  setHeader(
    event,
    "Content-Disposition",
    `attachment; filename="character.json"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  );
  setHeader(event, "Cache-Control", "no-store");

  return result.bundle;
});
