import { randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createError, getRouterParam, readMultipartFormData } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid, readTrimmedString } from "../../../../../utils/local-api";
import { dataPath } from "../../../../../utils/data-dir";
import { getPrisma } from "../../../../../utils/prisma";

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const MAX_EDGE = 1600;
const kinds = new Set(["STANDARD", "FRONT_VIEW", "SIDE_VIEW", "BACK_VIEW", "EXPRESSION", "OUTFIT", "ACCESSORY", "SUPPLEMENT"]);

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const parts = await readMultipartFormData(event).catch(() => null);
  if (!parts?.length) throw createError({ statusCode: 400, statusMessage: "没有收到上传内容。" });
  const file = parts.find(part => part.name === "file");
  const field = (name: string) => {
    const part = parts.find(item => item.name === name);
    return part?.data ? Buffer.from(part.data).toString("utf8") : "";
  };
  if (!file?.data?.length) throw createError({ statusCode: 400, statusMessage: "请先选择一张图片。" });
  if (file.data.length > MAX_UPLOAD_BYTES) throw createError({ statusCode: 413, statusMessage: "参考图片不能超过 12MB。" });
  const kind = field("kind").trim().toUpperCase();
  if (!kinds.has(kind)) throw createError({ statusCode: 400, statusMessage: "参考图片用途无效。" });
  const label = readTrimmedString(field("label"), "图片名称", 120, { required: true });

  let normalized: { data: Buffer; width: number; height: number };
  try {
    const result = await sharp(file.data, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    if (!result.info.width || !result.info.height) throw new Error("missing dimensions");
    normalized = { data: result.data, width: result.info.width, height: result.info.height };
  } catch {
    throw createError({ statusCode: 415, statusMessage: "无法识别图片。请上传有效的 PNG、JPG 或 WebP 文件。" });
  }

  const profile = await prisma.characterVisualProfile.upsert({
    where: { characterId },
    create: { characterId },
    update: {},
    select: { id: true },
  });
  const fileName = `${randomUUID()}.jpg`;
  const directory = dataPath("images", characterId);
  const absolutePath = path.join(directory, fileName);
  const relativePath = `images/${characterId}/${fileName}`;
  await mkdir(directory, { recursive: true });
  await writeFile(absolutePath, normalized.data, { flag: "wx", mode: 0o600 });
  try {
    const asset = await prisma.characterVisualAsset.create({
      data: {
        profileId: profile.id,
        kind: kind as "STANDARD" | "FRONT_VIEW" | "SIDE_VIEW" | "BACK_VIEW" | "EXPRESSION" | "OUTFIT" | "ACCESSORY" | "SUPPLEMENT",
        label,
        relativePath,
        mime: "image/jpeg",
        sizeBytes: normalized.data.length,
        width: normalized.width,
        height: normalized.height,
      },
    });
    return asset;
  } catch (error) {
    await unlink(absolutePath).catch(() => undefined);
    throw error;
  }
});
