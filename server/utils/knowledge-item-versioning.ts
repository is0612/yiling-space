export type KnowledgeItemEditablePatch = {
  title?: string;
  content?: string;
  category?: string;
  tags?: string[];
  confidence?: number | null;
};

export type ParsedKnowledgeItemPatch = {
  expectedRevision: number;
  patch: KnowledgeItemEditablePatch;
};

const EDITABLE_FIELDS = new Set(["title", "content", "category", "tags", "confidence"]);
const ALLOWED_FIELDS = new Set(["revision", ...EDITABLE_FIELDS]);

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function parseKnowledgeItemPatch(value: unknown): ParsedKnowledgeItemPatch {
  const body = asRecord(value);
  if (!Object.keys(body).length) throw new Error("请提供要修改的知识内容。");

  const unknownFields = Object.keys(body).filter(key => !ALLOWED_FIELDS.has(key));
  if (unknownFields.length) throw new Error("来源和系统字段不可编辑。");

  const expectedRevision = body.revision;
  if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) {
    throw new Error("知识版本号无效，请刷新后重试。");
  }

  const patch: KnowledgeItemEditablePatch = {};
  if (Object.hasOwn(body, "title")) {
    if (typeof body.title !== "string") throw new Error("知识标题格式无效。");
    const title = body.title.trim();
    if (!title || title.length > 240) throw new Error("知识标题不能为空，且不能超过 240 个字符。");
    patch.title = title;
  }
  if (Object.hasOwn(body, "content")) {
    if (typeof body.content !== "string") throw new Error("知识正文格式无效。");
    const content = body.content.trim();
    if (!content || content.length > 12_000) throw new Error("知识正文不能为空，且不能超过 12000 个字符。");
    patch.content = content;
  }
  if (Object.hasOwn(body, "category")) {
    if (typeof body.category !== "string") throw new Error("知识分类格式无效。");
    const category = body.category.trim();
    if (!category || category.length > 40) throw new Error("知识分类不能为空，且不能超过 40 个字符。");
    patch.category = category;
  }
  if (Object.hasOwn(body, "tags")) {
    if (!Array.isArray(body.tags) || body.tags.length > 20 || body.tags.some(tag => typeof tag !== "string")) {
      throw new Error("知识标签必须是最多 20 个文本标签。");
    }
    const tags = (body.tags as string[]).map(tag => tag.trim()).filter(Boolean);
    if (tags.some(tag => tag.length > 40)) throw new Error("单个知识标签不能超过 40 个字符。");
    patch.tags = [...new Map(tags.map(tag => [tag.toLocaleLowerCase(), tag])).values()];
  }
  if (Object.hasOwn(body, "confidence")) {
    if (body.confidence === null) {
      patch.confidence = null;
    } else if (typeof body.confidence === "number" && Number.isFinite(body.confidence)
      && body.confidence >= 0 && body.confidence <= 1) {
      patch.confidence = body.confidence;
    } else {
      throw new Error("可信度必须是 0 到 1 之间的数字，或留空。");
    }
  }

  if (!Object.keys(patch).length) throw new Error("没有提供可编辑的知识字段。");
  return { expectedRevision: expectedRevision as number, patch };
}

export function knowledgeItemPatchChanges(
  current: {
    title: string;
    content: string;
    category: string;
    tags: string[];
    confidence: number | null;
  },
  patch: KnowledgeItemEditablePatch,
): boolean {
  if (patch.title !== undefined && patch.title !== current.title) return true;
  if (patch.content !== undefined && patch.content !== current.content) return true;
  if (patch.category !== undefined && patch.category !== current.category) return true;
  if (patch.tags !== undefined && (patch.tags.length !== current.tags.length
    || patch.tags.some((tag, index) => tag !== current.tags[index]))) return true;
  if (Object.hasOwn(patch, "confidence") && patch.confidence !== current.confidence) return true;
  return false;
}
