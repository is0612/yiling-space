/**
 * QQ 内置表情（OneBot v11 的 `face` 段）。
 *
 * ⚠️ 这份清单故意不是全集：它是**给模型挑**的，不是 QQ 的表情表。菜刀、骷髅、炸弹这些
 * 也在 face 表里，但模型分不清「开玩笑」和「真生气」，一次误用就足够让人不适。
 *
 * face id 是 QQ 客户端内置表情的固定编号，各网关（NapCat / SnowLuma / go-cqhttp）一致。
 */

import type { OnebotSegment } from "./types";

export type OnebotFace = { id: string; name: string };

export const ONEBOT_FACES: readonly OnebotFace[] = [
  { id: "0", name: "惊讶" },
  { id: "4", name: "得意" },
  { id: "5", name: "流泪" },
  { id: "6", name: "害羞" },
  { id: "9", name: "大哭" },
  { id: "12", name: "调皮" },
  { id: "13", name: "呲牙" },
  { id: "14", name: "微笑" },
  { id: "15", name: "难过" },
  { id: "20", name: "偷笑" },
  { id: "21", name: "可爱" },
  { id: "22", name: "白眼" },
  { id: "26", name: "惊恐" },
  { id: "27", name: "流汗" },
  { id: "28", name: "憨笑" },
  { id: "32", name: "疑问" },
  { id: "34", name: "晕" },
  { id: "41", name: "抠鼻" },
  { id: "44", name: "坏笑" },
  { id: "49", name: "委屈" },
  { id: "50", name: "快哭了" },
  { id: "52", name: "亲亲" },
  { id: "54", name: "可怜" },
  { id: "66", name: "爱心" },
  { id: "78", name: "拥抱" },
  { id: "79", name: "强" },
];

const FACE_NAME_BY_ID = new Map(ONEBOT_FACES.map((face) => [face.id, face.name]));

function readFaceId(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value.trim();
  return "";
}

/** 入站：face id → 中文名；清单外的返回空串，让调用方退回通用占位符。 */
export function onebotFaceName(rawId: unknown): string {
  return FACE_NAME_BY_ID.get(readFaceId(rawId)) ?? "";
}

/** 出站：只认清单内的 id，去重后最多 `max` 个——模型偶尔会自己编 id，或一次给三个。 */
export function readOnebotFaceIds(value: unknown, max = 1): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    const id = readFaceId(item);
    if (!FACE_NAME_BY_ID.has(id) || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= max) break;
  }
  return ids;
}

/** 表情段。单独发一条，不拼进正文：真人也是这么发的。 */
export function toOnebotFaceSegments(faceIds: readonly string[]): OnebotSegment[] {
  return faceIds.map((id) => ({ type: "face", data: { id } }));
}
