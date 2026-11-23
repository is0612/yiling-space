import type { PrismaClient } from "../../../src/generated/prisma/client";
import type { ChannelTurnMessage } from "./pipeline";
import { findGeneratedImageAsset, inspectGeneratedImageAsset, type GeneratedImageAssetScope } from "../image-assets";
import type { GeneratedImageFacts } from "../image-facts";
import { applyImageDescriptions, describeImages, type ImageUnderstandingSettings } from "../image-understanding";
import { isExplicitMediaQuestion, isLatestGeneratedImageQuestion, isLatestGeneratedPromptQuestion, type MediaVisionBudget } from "../media-questions";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Explicit latest-result references only; older/ambiguous references must use an actual quote. */
export async function inspectLatestGeneratedImageForQuestion(
  text: string, input: { prisma: PrismaClient; scope: GeneratedImageAssetScope; settings: ImageUnderstandingSettings | null; budget: MediaVisionBudget },
): Promise<GeneratedImageFacts | null> {
  const wantsVision = isLatestGeneratedImageQuestion(text);
  if (!wantsVision && !isLatestGeneratedPromptQuestion(text)) return null;
  const latest = await input.prisma.message.findFirst({ where: { role: "ASSISTANT", conversation: {
    characterId: input.scope.characterId, channelBindingId: input.scope.bindingId, externalConversationId: input.scope.externalConversationId,
  }, metadata: { path: ["replyDelivery", "image", "status"], equals: "sent" } }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], select: { metadata: true } }).catch(() => null);
  const externalId = record(record(record(latest?.metadata).replyDelivery).image).externalMessageId;
  if (typeof externalId !== "string") return null;
  const asset = await findGeneratedImageAsset(input.prisma, input.scope, externalId);
  if (!asset) return null;
  return wantsVision ? inspectGeneratedImageAsset(input.prisma, asset, input.settings, () => input.budget.consume()) : asset.facts;
}

/** Verified quote refs only. All image reads share the same turn budget as direct attachments. */
export async function attachQuotedImageDescriptions(
  messages: ChannelTurnMessage[], input: { prisma: PrismaClient; scope: GeneratedImageAssetScope; settings: ImageUnderstandingSettings | null; budget: MediaVisionBudget },
  services: { find: typeof findGeneratedImageAsset; inspect: typeof inspectGeneratedImageAsset; describe: typeof describeImages } = { find: findGeneratedImageAsset, inspect: inspectGeneratedImageAsset, describe: describeImages },
): Promise<ChannelTurnMessage[]> {
  const cache = new Map<string, Promise<ChannelTurnMessage["quotedMessage"]>>();
  return Promise.all(messages.map(async message => {
    const quoted = message.quotedMessage;
    // A verified self quote may contain only its platform id; resolve the stored asset
    // before requiring image segments from get_msg (gateways may omit those).
    if (!quoted || !(quoted.isSelf || quoted.images?.length || quoted.image)) return message;
    const observe = message.kind !== "AI" && !message.readOnly && isExplicitMediaQuestion(message.commandText ?? "", true);
    const key = `${quoted.messageId}:${quoted.isSelf === true}:${observe}`;
    if (!cache.has(key)) cache.set(key, (async () => {
      const { images, imageTextParts, ...safeQuote } = quoted;
      if (quoted.isSelf) {
        const asset = await services.find(input.prisma, input.scope, quoted.messageId);
        if (asset) {
          const facts = observe ? await services.inspect(input.prisma, asset, input.settings, () => input.budget.consume()) : asset.facts;
          return { ...safeQuote, image: facts };
        }
      }
      if (!observe || !input.settings || !images?.length || !input.budget.remaining) return safeQuote;
      const index = images.findIndex(ref => Boolean(ref.url));
      if (index < 0 || !input.budget.consume()) return safeQuote;
      const descriptions: Array<string | null | undefined> = new Array(images.length).fill(undefined);
      const result = await services.describe([images[index]!], input.settings, { characterId: input.scope.characterId, channelBindingId: input.scope.bindingId }).catch(() => []);
      descriptions[index] = result[0] ?? null;
      return { ...safeQuote, content: applyImageDescriptions(safeQuote.content ?? "[图片]", descriptions, imageTextParts).slice(0, 2000) };
    })());
    return { ...message, quotedMessage: await cache.get(key)! };
  }));
}
