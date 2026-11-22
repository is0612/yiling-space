import fs from "node:fs/promises";
import path from "node:path";
import type { PrismaClient, Prisma } from "../../src/generated/prisma/client";
import { dataPath } from "./data-dir";
import { describeImageBuffer, type ImageUnderstandingSettings } from "./image-understanding";

export type GeneratedImageAssetScope = { characterId: string; bindingId: string; externalConversationId: string };
import { sanitizeGeneratedImageFacts, type GeneratedImageFacts } from "./image-facts";
export type ScopedGeneratedImageAsset = { messageId: string; scope: GeneratedImageAssetScope; path: string; facts: GeneratedImageFacts };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function readGeneratedImageFacts(metadata: unknown): GeneratedImageFacts | null {
  const image = record(record(metadata).image);
  if (typeof image.path !== "string" || !image.path.startsWith("images/")) return null;
  const generation = record(image.generation);
  const vision = record(image.vision);
  const description = typeof vision.description === "string" ? vision.description.trim().slice(0, 400) : "";
  const status = ["not_requested", "disabled", "ok", "failed", "budget_exhausted", "missing_file"].includes(String(vision.status))
    ? vision.status as GeneratedImageFacts["visual"]["status"] : "not_requested";
  return sanitizeGeneratedImageFacts({ origin: "self_generated", mode: "text_to_image",
    ...(typeof generation.generatedAt === "string" && Number.isFinite(Date.parse(generation.generatedAt)) ? { generatedAt: generation.generatedAt } : {}),
    ...(typeof generation.prompt === "string" ? { requestedDescription: generation.prompt.slice(0, 1200) } : {}),
    visual: status === "ok" && description ? { status: "ok", description } : { status: status === "ok" ? "failed" : status },
  });
}

/** Every query is constrained to one role, binding and conversation; duplicate ids fail closed. */
export async function findGeneratedImageAsset(prisma: PrismaClient, scope: GeneratedImageAssetScope, externalMessageId: string): Promise<ScopedGeneratedImageAsset | null> {
  if (!scope.characterId || !scope.bindingId || !scope.externalConversationId || !/^-?\d+$/u.test(externalMessageId)) return null;
  const rows = await prisma.message.findMany({ where: { role: "ASSISTANT", conversation: {
    characterId: scope.characterId, channelBindingId: scope.bindingId, externalConversationId: scope.externalConversationId,
  }, AND: [{ metadata: { path: ["replyDelivery", "image", "status"], equals: "sent" } },
    { metadata: { path: ["replyDelivery", "image", "externalMessageId"], equals: externalMessageId } }] }, select: { id: true, metadata: true }, take: 2 }).catch(() => []);
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  const image = record(record(row.metadata).image);
  const facts = readGeneratedImageFacts(row.metadata);
  return facts && typeof image.path === "string" ? { messageId: row.id, scope: { ...scope }, path: image.path, facts } : null;
}

/** Only server-owned files under this role's image directory may be read. */
export async function readGeneratedImageBuffer(asset: ScopedGeneratedImageAsset): Promise<{ buffer: Buffer; mime: string } | null> {
  if (!/^[a-zA-Z0-9_-]+$/u.test(asset.scope.characterId)) return null;
  const relative = asset.path.replace(/\\/gu, "/");
  if (!relative.startsWith(`images/${asset.scope.characterId}/`) || path.isAbsolute(relative) || relative.split("/").includes("..")) return null;
  try {
    const root = await fs.realpath(dataPath("images", asset.scope.characterId));
    const candidate = await fs.realpath(dataPath(relative));
    if (!candidate.startsWith(root + path.sep)) return null;
    const stat = await fs.stat(candidate);
    if (!stat.isFile() || stat.size < 1 || stat.size > 4 * 1024 * 1024) return null;
    const buffer = await fs.readFile(candidate);
    if (!buffer.length || buffer.length > 4 * 1024 * 1024) return null;
    const sharp = (await import("sharp")).default;
    const metadata = await sharp(buffer).metadata();
    const mime = metadata.format === "jpeg" ? "image/jpeg" : metadata.format === "png" ? "image/png" : metadata.format === "webp" ? "image/webp" : "";
    return mime ? { buffer, mime } : null;
  } catch { return null; }
}

/** Lazy inspection: caller provides the existing vision switch/settings and shared per-turn budget. */
export async function inspectGeneratedImageAsset(prisma: PrismaClient, asset: ScopedGeneratedImageAsset, settings: ImageUnderstandingSettings | null, consumeBudget: () => boolean): Promise<GeneratedImageFacts> {
  const verified = await prisma.message.findFirst({ where: { id: asset.messageId, role: "ASSISTANT", conversation: {
    characterId: asset.scope.characterId, channelBindingId: asset.scope.bindingId, externalConversationId: asset.scope.externalConversationId,
  } }, select: { metadata: true } }).catch(() => null);
  const storedImage = record(record(verified?.metadata).image);
  if (!verified || storedImage.path !== asset.path) return { ...asset.facts, visual: { status: "missing_file" } };
  const verifiedFacts = readGeneratedImageFacts(verified.metadata);
  if (verifiedFacts?.visual.status === "ok") return verifiedFacts;
  if (!settings) return { ...asset.facts, visual: { status: "disabled" } };
  if (!consumeBudget()) return { ...asset.facts, visual: { status: "budget_exhausted" } };
  const image = await readGeneratedImageBuffer(asset);
  const description = image ? await describeImageBuffer(image, settings, { characterId: asset.scope.characterId, channelBindingId: asset.scope.bindingId }).catch(() => null) : null;
  const visual: GeneratedImageFacts["visual"] = !image ? { status: "missing_file" } : description ? { status: "ok", description } : { status: "failed" };
  try {
    const row = await prisma.message.findFirst({ where: { id: asset.messageId, role: "ASSISTANT", conversation: {
      characterId: asset.scope.characterId, channelBindingId: asset.scope.bindingId, externalConversationId: asset.scope.externalConversationId,
    } }, select: { metadata: true } });
    if (row) {
      const metadata = record(row.metadata);
      const storedImage = record(metadata.image);
      if (storedImage.path === asset.path) await prisma.message.updateMany({ where: { id: asset.messageId, conversation: {
        characterId: asset.scope.characterId, channelBindingId: asset.scope.bindingId, externalConversationId: asset.scope.externalConversationId,
      } }, data: { metadata: { ...metadata, image: { ...storedImage, vision: { ...visual, model: settings.model, observedAt: new Date().toISOString() } } } as Prisma.InputJsonObject } });
    }
  } catch { /* A diagnostic write cannot turn a successful read into a failed chat. */ }
  return { ...asset.facts, visual };
}
