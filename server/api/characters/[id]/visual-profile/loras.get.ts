import { createError } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { listComfyLoras, normalizeComfyBaseUrl } from "../../../../utils/comfyui-image";

/**
 * 引擎里装了哪些 LoRA —— 形象档案页那个下拉框的数据来源。
 *
 * 地址取角色自己的画图地址（就是她在用的那个引擎），不取全局环境变量：
 * 同一个程序里可能有两个角色连不同引擎，各看各的才不会填错。
 * 引擎没开时返回 `ok: false`，页面提示「先启动 Anima」，而不是给一个空列表 ——
 * 空列表会被理解成「一个 LoRA 都没装」。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { modelConfig: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const config = character.modelConfig && typeof character.modelConfig === "object" && !Array.isArray(character.modelConfig)
    ? character.modelConfig as Record<string, unknown>
    : {};
  const configured = typeof config.imageApiBaseUrl === "string" ? config.imageApiBaseUrl.trim() : "";

  let base: string;
  try {
    base = normalizeComfyBaseUrl(configured);
  } catch (error) {
    return { ok: false as const, models: [], reason: error instanceof Error ? error.message : "引擎地址无效" };
  }

  const result = await listComfyLoras(base);
  if (!result.ok) {
    return { ok: false as const, models: [], reason: `连不上引擎（${base}），先确认 Anima 在运行。` };
  }
  return { ok: true as const, models: result.models, baseUrl: base };
});
