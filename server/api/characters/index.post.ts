import { randomUUID } from "node:crypto";
import { readBody } from "h3";
import { characterInclude, toCharacterDto } from "../../utils/character-dto";
import { requireActorUserId } from "../../utils/auth";
import { readTrimmedString } from "../../utils/local-api";
import { getPrisma } from "../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const body = await readBody<Record<string, unknown>>(event);
  const name = readTrimmedString(body.name, "角色名称", 100, { required: true });
  const alias = readTrimmedString(body.alias, "角色标签", 100) || "新建角色";
  const description = readTrimmedString(body.description, "角色简介", 2000);
  const personality = readTrimmedString(body.personality, "基础人设", 12000);
  // 对话示例是可选增量：老客户端不传就当空，不注入提示词（等于迁移前行为）
  const examples = readTrimmedString(body.examples, "对话示例", 8000);
  const userAddress = readTrimmedString(body.userAddress, "她对你的称呼", 40) || "主人";
  const avatarTone = body.avatarTone === "purple" || body.avatarTone === "peach" || body.avatarTone === "blue"
    ? body.avatarTone
    : "mint";
  const prisma = getPrisma();

  const characterId = randomUUID();
  const created = await prisma.character.create({
    data: {
      id: characterId,
      ownerId,
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
          snapshotIntervalDays: 8,
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
