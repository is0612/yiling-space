import { createError, getRequestHeader, getRouterParam, readMultipartFormData } from "h3";
import { parseKnowledgeImportFile, splitKnowledgeImportContent } from "../../../../../../utils/knowledge-import";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const contentLength = Number(getRequestHeader(event, "content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 2 * 1024 * 1024 + 64 * 1024) {
    throw createError({ statusCode: 413, statusMessage: "上传请求不能超过 2 MB（含少量表单开销）。" });
  }
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

  const chunks = splitKnowledgeImportContent(parsed.rawContent);
  if (!chunks.length) {
    throw createError({ statusCode: 400, statusMessage: "文件里没有可整理的内容。" });
  }
  const importedAt = new Date().toISOString();
  const created = await prisma.$transaction(
    chunks.map((chunk, index) => prisma.knowledgeCandidate.create({
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
          importedAt,
          // 一份文件会被拆成多条候选：带上序号与标题，才能说清这条来自原文件的哪一段。
          chunkIndex: index,
          chunkCount: chunks.length,
          chunkTitle: chunk.title,
        },
        rawContent: chunk.content,
      },
      select: { id: true, sourceType: true, sourceRef: true, rawContent: true, status: true, createdAt: true },
    })),
  );

  setResponseStatus(event, 201);
  // `candidate` 保留单条形态，兼容只读第一条的旧调用；新调用请用 `candidates`。
  return { candidates: created, candidate: created[0], chunkCount: created.length };
});
