import { createError } from "h3";
import { readTrimmedString } from "./local-api";

export function readCharacterBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw createError({ statusCode: 400, statusMessage: "角色资料必须是对象。" });
  }
  return value as Record<string, unknown>;
}

/** Missing = unchanged, empty = clear, wrong type = reject (never silently erase a profile). */
export function readCharacterProfilePatch(body: Record<string, unknown>) {
  const data: { name?: string; basePrompt?: string; styleExamples?: string; userAddress?: string } = {};
  const modelConfig: { alias?: string; description?: string } = {};
  const fields = [
    ["name", "角色名称", 100], ["personality", "基础人设", 12000],
    ["examples", "对话示例", 8000], ["userAddress", "她对你的称呼", 40],
    ["alias", "角色标签", 100], ["description", "角色简介", 2000],
  ] as const;
  const parsed: Record<string, string> = {};
  for (const [field, label, max] of fields) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== "string") throw createError({ statusCode: 400, statusMessage: `${label}必须是文本。` });
    parsed[field] = readTrimmedString(body[field], label, max, { required: field === "name" });
  }
  if (parsed.name !== undefined) data.name = parsed.name;
  if (parsed.personality !== undefined) data.basePrompt = parsed.personality;
  if (parsed.examples !== undefined) data.styleExamples = parsed.examples;
  if (parsed.userAddress !== undefined) data.userAddress = parsed.userAddress;
  if (parsed.alias !== undefined) modelConfig.alias = parsed.alias;
  if (parsed.description !== undefined) modelConfig.description = parsed.description;
  return { data, modelConfig };
}
