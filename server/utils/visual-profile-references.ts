import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "../../src/generated/prisma/client";
import type { SnapshotAsset } from "./visual-profile-snapshot";
import { dataPath } from "./data-dir";

/**
 * 形象档案 → 生图参考图。
 * 参考素材必须来自当前正式版本快照中的 assets，而不是实时素材库。
 * 未发布的上传/删除不会悄悄改变正式形象。快照只保存引用，不保存图片字节；
 * 文件缺失或引用失效时安全跳过，不影响普通文生图。
 */

const REFERENCE_KINDS = ["STANDARD", "FRONT_VIEW", "SIDE_VIEW", "BACK_VIEW"] as const;
const KIND_LABEL: Record<string, string> = {
  STANDARD: "标准形象",
  FRONT_VIEW: "正面视图",
  SIDE_VIEW: "侧面视图",
  BACK_VIEW: "背面视图",
};
export const MAX_VISUAL_REFERENCES = 4;
const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;

export type VisualReference = {
  assetId: string;
  label: string;
  mime: string;
  buffer: Buffer;
};

export function isVisualAssetPathSafe(characterId: string, relativePath: string): boolean {
  if (!characterId) return false;
  const relative = String(relativePath ?? "").replace(/\\\\/gu, "/");
  if (!relative.startsWith("visual-profile/" + characterId + "/")) return false;
  if (path.isAbsolute(relative)) return false;
  return !relative.split("/").includes("..");
}

/** 每种用途先选一张，再按优先级补足剩余名额。 */
export function selectSnapshotReferenceAssets(snapshotAssets: unknown): SnapshotAsset[] {
  if (!Array.isArray(snapshotAssets)) return [];
  const candidates = snapshotAssets.filter((value): value is SnapshotAsset => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    return typeof item.id === "string" && item.id.length > 0
      && typeof item.kind === "string" && REFERENCE_KINDS.includes(item.kind as typeof REFERENCE_KINDS[number])
      && typeof item.relativePath === "string" && typeof item.label === "string"
      && typeof item.sortOrder === "number" && Number.isFinite(item.sortOrder);
  });
  const rank = (kind: string) => REFERENCE_KINDS.indexOf(kind as typeof REFERENCE_KINDS[number]);
  candidates.sort((a, b) => {
    const kindOrder = rank(a.kind) - rank(b.kind);
    if (kindOrder) return kindOrder;
    const aTime = typeof a.createdAt === "string" ? Date.parse(a.createdAt) : Number.NaN;
    const bTime = typeof b.createdAt === "string" ? Date.parse(b.createdAt) : Number.NaN;
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime;
    return a.sortOrder - b.sortOrder;
  });
  const selected: SnapshotAsset[] = [];
  const selectedIds = new Set<string>();
  // 第一轮每种类型最多取一张，避免 STANDARD 素材挤掉三视图。
  for (const kind of REFERENCE_KINDS) {
    const item = candidates.find(candidate => candidate.kind === kind);
    if (item && !selectedIds.has(item.id)) {
      selected.push(item);
      selectedIds.add(item.id);
    }
    if (selected.length >= MAX_VISUAL_REFERENCES) return selected;
  }
  // 某些类型缺失时，再用其它候选补满名额。
  for (const item of candidates) {
    if (selected.length >= MAX_VISUAL_REFERENCES) break;
    if (!selectedIds.has(item.id)) {
      selected.push(item);
      selectedIds.add(item.id);
    }
  }
  return selected;
}

async function readOne(
  characterId: string,
  asset: SnapshotAsset & { mime: string },
): Promise<VisualReference | null> {
  if (!isVisualAssetPathSafe(characterId, asset.relativePath)) return null;
  const relative = asset.relativePath.replace(/\\\\/gu, "/");
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

/** 只读取正式快照明确引用的素材 ID；旧快照没有 assets 时不回退到实时素材库。 */
export async function readVisualProfileReferences(
  prisma: PrismaClient,
  characterId: string,
  snapshotAssets: unknown,
): Promise<VisualReference[]> {
  if (!characterId) return [];
  const selected = selectSnapshotReferenceAssets(snapshotAssets);
  if (!selected.length) return [];

  const rows = await prisma.characterVisualAsset.findMany({
    where: {
      id: { in: selected.map(asset => asset.id) },
      profile: { characterId },
      kind: { in: [...REFERENCE_KINDS] },
    },
    select: { id: true, kind: true, relativePath: true, mime: true },
  }).catch(() => []);
  const byId = new Map(rows.map(row => [row.id, row]));
  const found: VisualReference[] = [];
  for (const snapshotAsset of selected) {
    const row = byId.get(snapshotAsset.id);
    // DB 元数据与快照不一致时不猜测，避免同 ID 被改指向其他文件。
    if (!row || row.kind !== snapshotAsset.kind || row.relativePath !== snapshotAsset.relativePath) continue;
    const reference = await readOne(characterId, { ...snapshotAsset, mime: row.mime });
    if (reference) found.push(reference);
  }

  const totals = new Map<string, number>();
  for (const reference of found) totals.set(reference.label, (totals.get(reference.label) ?? 0) + 1);
  const used = new Map<string, number>();
  for (const reference of found) {
    if ((totals.get(reference.label) ?? 0) < 2) continue;
    const next = (used.get(reference.label) ?? 0) + 1;
    used.set(reference.label, next);
    reference.label = reference.label + next;
  }
  return found;
}
