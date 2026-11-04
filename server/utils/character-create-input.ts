import { readCharacterBody } from "./character-profile-input";
import { readTrimmedString } from "./local-api";

/** Keep create defaults in one place; an explicit empty address is not a missing field. */
export function readCharacterCreateInput(value: unknown) {
  const body = readCharacterBody(value);
  return {
    name: readTrimmedString(body.name, "角色名称", 100, { required: true }),
    alias: readTrimmedString(body.alias, "角色标签", 100) || "新建角色",
    description: readTrimmedString(body.description, "角色简介", 2000),
    personality: readTrimmedString(body.personality, "基础人设", 12000),
    examples: readTrimmedString(body.examples, "对话示例", 8000),
    userAddress: body.userAddress === undefined ? "主人" : readTrimmedString(body.userAddress, "她对你的称呼", 40),
    avatarTone: body.avatarTone === "purple" || body.avatarTone === "peach" || body.avatarTone === "blue"
      ? body.avatarTone : "mint",
  };
}
