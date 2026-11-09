import { createError, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";
import { fetchKnowledgeWebPage } from "../../../../../../utils/knowledge-web-import";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const body = await readBody<{ url?: unknown }>(event);
  const rawUrl = typeof body?.url === "string" ? body.url.trim() : "";
  if (!rawUrl || rawUrl.length > 2_048) {
    throw createError({ statusCode: 400, statusMessage: "请提供有效的网址（最多 2048 个字符）。" });
  }

  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  let page;
  try {
    page = await fetchKnowledgeWebPage(rawUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "网页采集失败。";
    const statusCode = /超过 1\.5 MB/.test(message) ? 413
      : /阻止访问|只允许|有效的 HTTP|过短|提取到正文|UTF-8|支持的 HTML/.test(message) ? 400
      : 502;
    throw createError({ statusCode, statusMessage: message });
  }

  const candidate = await prisma.knowledgeCandidate.create({
    data: {
      characterId,
      sourceType: "IMPORT",
      sourceRef: {
        kind: "WEB",
        originalUrl: page.originalUrl,
        finalUrl: page.finalUrl,
        title: page.title,
        mediaType: page.mediaType,
        httpStatus: page.httpStatus,
        byteSize: page.byteSize,
        sha256: page.sha256,
        fetchedAt: new Date().toISOString(),
        untrustedExternalContent: true,
      },
      rawContent: page.rawContent,
    },
    select: { id: true, sourceType: true, sourceRef: true, rawContent: true, status: true, createdAt: true },
  });

  setResponseStatus(event, 201);
  return { candidate };
});
