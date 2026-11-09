import { createError, getRouterParam, readMultipartFormData } from "h3";
import { parseKnowledgeImportFile } from "../../../../../../utils/knowledge-import";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const parts = await readMultipartFormData(event);
  if (!parts?.length) {
    throw createError({ statusCode: 400, statusMessage: "请选择一个 TXT 或 Markdown 文件。" });
  }
  const files = parts.filter(part => part.name === "file" && part.filename);
  if (files.length !== 1) {
    throw createError({ statusCode: 400, statusMessage: "一次只能导入一个文件。" });
  }
  const file = files[0]!;
  let parsed;
  try {
    parsed = parseKnowledgeImportFile({
      filename: file.filename ?? "",
      mediaType: file.type,
      data: file.data,
    });
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : "文件解析失败。",
    });
  }

  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const candidate = await prisma.knowledgeCandidate.create({
    data: {
      characterId,
      sourceType: "IMPORT",
      sourceRef: {
        kind: "FILE",
        filename: parsed.filename,
        extension: parsed.extension,
        mediaType: parsed.mediaType,
        byteSize: parsed.byteSize,
        sha256: parsed.sha256,
        importedAt: new Date().toISOString(),
      },
      rawContent: parsed.rawContent,
    },
    select: { id: true, sourceType: true, sourceRef: true, rawContent: true, status: true, createdAt: true },
  });

  setResponseStatus(event, 201);
  return { candidate };
});
