import { getRouterParam } from "h3";
import { resolveChatModelSettings } from "../../../../utils/chat-model-config";
import {
  resolveMemoryAssistantRuntime,
  testMemoryAssistantConnection,
} from "../../../../utils/memory-assistant";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const character = await getPrisma().character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true, modelConfig: true },
  });
  if (!character) return { ok: false, message: "角色不存在。" };

  const chatSettings = resolveChatModelSettings(character.modelConfig);
  // 测试连接不要求先启用助手，但仍只读取记忆助手自己的模型、地址与加密 Key。
  const runtime = await resolveMemoryAssistantRuntime(
    character.modelConfig,
    chatSettings.apiBaseUrl,
    { requireEnabled: false },
  );
  if (!runtime) {
    const config = character.modelConfig !== null && typeof character.modelConfig === "object" && !Array.isArray(character.modelConfig)
      ? character.modelConfig as Record<string, unknown>
      : {};
    const model = typeof config.memoryAssistantModel === "string" ? config.memoryAssistantModel.trim() : "";
    return {
      ok: false,
      message: !model
        ? "请先填写记忆助手模型名称。"
        : "未找到已保存的记忆助手独立 API Key。请填写并保存后再测试。",
    };
  }

  return testMemoryAssistantConnection(runtime);
});
