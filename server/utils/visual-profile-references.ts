import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { dataPath } from "./data-dir";

/**
 * 形象档案 → 生图参考图。
 *
 * 只取「定长相」用的那几种：标准形象、正面 / 侧面 / 背面视图。
 * 表情、服装、配饰不进来 —— 表情由画面决定，服装由【造型】决定，
 * 把它们一起当长相参考，只会让模型把某一套衣服固化成她的本体。
 *
 * 单张失败就跳过，一张都不剩时返回空数组：参考图是加成，不该让整次生成失败。
 */

/** 顺序即优先级：标准形象最能代表长相，其次是三视图。 */
const REFERENCE_KINDS = ["STANDARD", "FRONT_VIEW", "SIDE_VIEW", "BACK_VIEW"] as const;

const KIND_LABEL: Record<string, string> = {
  STANDARD: "标准形象",
  FRONT_VIEW: "正面视图",
  SIDE_VIEW: "侧面视图",
  BACK_VIEW: "背面视图",
};

/** 多数 edits 接口对图片数量有上限，四张（1 标准 + 3 视图）是够用的最小集。 */
export const MAX_VISUAL_REFERENCES = 4;

/** 单张上限 4MB：与 `readGeneratedImageBuffer` 同一条线，理由也一样。 */
const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;

export type VisualReference = {
  assetId: string;
  /** 进【参考图】段的中文名，如「标准形象」。 */
  label: string;
  mime: string;
  buffer: Buffer;
};

/**
 * 素材相对路径是否落在当前角色的档案目录里。
 *
 * 与素材预览接口同一套判据：只认 `visual-profile/<characterId>/` 开头、
 * 不是绝对路径、不含 `..`。抽出来是为了能单独测。
 */
export function isVisualAssetPathSafe(characterId: string, relativePath: string): boolean {
  if (!characterId) return false;
  const relative = String(relativePath ?? "").replace(/\\/gu, "/");
  if (!relative.startsWith(`visual-profile/${characterId}/`)) return false;
  if (path.isAbsolute(relative)) return false;
  return !relative.split("/").includes("..");
}

async function readOne(
  characterId: string,
  asset: { id: string; kind: string; relativePath: string; mime: string },
): Promise<VisualReference | null> {
  if (!isVisualAssetPathSafe(characterId, asset.relativePath)) return null;
  const relative = asset.relativePath.replace(/\\/gu, "/");
  try {
    const root = await realpath(dataPath("visual-profile", characterId));
    const absolute = await realpath(dataPath(relative));
    if (!absolute.startsWith(root + path.sep)) return null;
    const info = await stat(absolute);
    if (!info.isFile() || info.size < 1 || info.size > MAX_REFERENCE_BYTES) return null;
    const buffer = await readFile(absolute);
    if (!buffer.length || buffer.length > MAX_REFERENCE_BYTES) return null;
    return {
      assetId: asset.id,
      label: KIND_LABEL[asset.kind] ?? asset.kind,
      mime: asset.mime || "image/jpeg",
      buffer,
    };
  } catch {
    return null;
  }
}

/**
 * 读出这个角色能当参考图的档案素材。
 *
 * 调用方要自己决定「现在该不该用参考图」——比如只在该角色已有正式版本时用，
 * 免得半成品草稿还没发布就影响了画面。
 */
export async function readVisualProfileReferences(
  prisma: PrismaClient,
  characterId: string,
): Promise<VisualReference[]> {
  if (!characterId) return [];
  const assets = await prisma.characterVisualAsset.findMany({
    where: { profile: { characterId }, kind: { in: [...REFERENCE_KINDS] } },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, kind: true, relativePath: true, mime: true },
    take: MAX_VISUAL_REFERENCES * 2,
  }).catch(() => []);
  if (!assets.length) return [];

  const rank = (kind: string) => {
    const index = REFERENCE_KINDS.indexOf(kind as typeof REFERENCE_KINDS[number]);
    return index === -1 ? REFERENCE_KINDS.length : index;
  };
  const ordered = [...assets].sort((left, right) => rank(left.kind) - rank(right.kind));

  const found: VisualReference[] = [];
  for (const asset of ordered) {
    if (found.length >= MAX_VISUAL_REFERENCES) break;
    const reference = await readOne(characterId, asset);
    if (reference) found.push(reference);
  }

  /**
   * 同一用途可能有多张（标准形象尤其常见）。给重复的补序号，
   * 否则【参考图】段里会出现两个「标准形象」，模型没法区分它们是两张图。
   */
  const totals = new Map<string, number>();
  for (const reference of found) totals.set(reference.label, (totals.get(reference.label) ?? 0) + 1);
  const used = new Map<string, number>();
  for (const reference of found) {
    if ((totals.get(reference.label) ?? 0) < 2) continue;
    const next = (used.get(reference.label) ?? 0) + 1;
    used.set(reference.label, next);
    reference.label = `${reference.label}${next}`;
  }
  return found;
}
