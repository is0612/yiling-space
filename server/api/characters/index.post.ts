import { randomUUID } from "node:crypto";
import { readBody } from "h3";
import { characterInclude, toCharacterDto } from "../../utils/character-dto";
import { requireActorUserId } from "../../utils/auth";
import { readCharacterCreateInput } from "../../utils/character-create-input";
import { getPrisma } from "../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const { name, alias, description, personality, examples, userAddress, avatarTone } =
    readCharacterCreateInput(await readBody<unknown>(event));
  const prisma = getPrisma();

  const characterId = randomUUID();
  const created = await prisma.character.create({
    data: {
      id: characterId,
      ownerId,
      // 本机新建角色以自己的实例 ID 作为稳定同步根；导入副本则继承卡片上的根。
      originCharacterId: characterId,
      name,
      avatar: name.slice(0, 1),
      basePrompt: personality || "请补充角色的人设与行为规则。",
      styleExamples: examples,
      userAddress,
      // 新建即可对话：停用是用户显式动作（角色管理 → 停用），不是默认态。
      status: "ACTIVE",
      modelConfig: { alias, description, avatarTone },
      memoryScopes: {
        create: {
          scopeType: "CHARACTER_GLOBAL",
          scopeKey: `character:${characterId}:global`,
        },
      },
      memorySetting: {
        create: {
          snapshotIntervalDays: 3,
          timezone: "Asia/Shanghai",
          anchorAt: new Date(),
          autoSnapshotEnabled: false,
          // 默认建议保留 30 天：群聊原文会随热闹程度快速堆积，靠它兜住体积。
          // 清理开关仍默认关 —— 真删除必须由用户在记忆设置里明确确认，不能默认动数据。
          rawMessageRetentionDays: 30,
          rawMessageCleanupEnabled: false,
        },
      },
    },
    include: characterInclude,
  });

  setResponseStatus(event, 201);
  return toCharacterDto(created);
});
