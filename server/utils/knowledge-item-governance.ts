export type KnowledgeMergeInput = {
  targetItemId: string;
  expectedSourceRevision: number;
  expectedTargetRevision: number;
  title: string;
  content: string;
  category: string;
  tags: string[];
  confidence: number | null;
};

export type KnowledgeRelationDecisionInput = {
  action: "CONFIRM_CONFLICT" | "NEEDS_VERIFICATION" | "KEEP_SEPARATE" | "DISMISS";
  expectedSourceRevision: number;
  expectedTargetRevision: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function revision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label}版本号无效，请刷新后重试。`);
  }
  return value as number;
}

export function parseKnowledgeMergeInput(value: unknown): KnowledgeMergeInput {
  const body = asRecord(value);
  const allowed = new Set([
    "targetItemId", "expectedSourceRevision", "expectedTargetRevision",
    "title", "content", "category", "tags", "confidence",
  ]);
  if (!Object.keys(body).length) throw new Error("请提供合并后的知识内容。");
  if (Object.keys(body).some(key => !allowed.has(key))) throw new Error("合并请求包含不允许修改的字段。");
  if (typeof body.targetItemId !== "string" || !body.targetItemId.trim()) {
    throw new Error("请选择合并目标知识。");
  }
  if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 240) {
    throw new Error("合并后的标题不能为空，且不能超过 240 个字符。");
  }
  if (typeof body.content !== "string" || !body.content.trim() || body.content.trim().length > 12_000) {
    throw new Error("合并后的正文不能为空，且不能超过 12000 个字符。");
  }
  if (typeof body.category !== "string" || !body.category.trim() || body.category.trim().length > 40) {
    throw new Error("合并后的分类不能为空，且不能超过 40 个字符。");
  }
  if (!Array.isArray(body.tags) || body.tags.length > 20 || body.tags.some(tag => typeof tag !== "string")) {
    throw new Error("合并后的标签必须是最多 20 个文本标签。");
  }
  const tags = (body.tags as string[]).map(tag => tag.trim()).filter(Boolean);
  if (tags.some(tag => tag.length > 40)) throw new Error("单个知识标签不能超过 40 个字符。");
  let confidence: number | null;
  if (body.confidence === null) confidence = null;
  else if (typeof body.confidence === "number" && Number.isFinite(body.confidence)
    && body.confidence >= 0 && body.confidence <= 1) confidence = body.confidence;
  else throw new Error("可信度必须是 0 到 1 之间的数字，或留空。");

  return {
    targetItemId: body.targetItemId.trim(),
    expectedSourceRevision: revision(body.expectedSourceRevision, "源知识"),
    expectedTargetRevision: revision(body.expectedTargetRevision, "目标知识"),
    title: body.title.trim(),
    content: body.content.trim(),
    category: body.category.trim(),
    tags: [...new Map(tags.map(tag => [tag.toLocaleLowerCase(), tag])).values()],
    confidence,
  };
}

export function parseKnowledgeRelationDecision(value: unknown): KnowledgeRelationDecisionInput {
  const body = asRecord(value);
  const allowed = new Set(["action", "expectedSourceRevision", "expectedTargetRevision"]);
  if (Object.keys(body).some(key => !allowed.has(key))) throw new Error("处置请求包含不允许的字段。");
  const actions = new Set(["CONFIRM_CONFLICT", "NEEDS_VERIFICATION", "KEEP_SEPARATE", "DISMISS"]);
  if (typeof body.action !== "string" || !actions.has(body.action)) {
    throw new Error("请选择有效的关系处置方式。");
  }
  return {
    action: body.action as KnowledgeRelationDecisionInput["action"],
    expectedSourceRevision: revision(body.expectedSourceRevision, "源知识"),
    expectedTargetRevision: revision(body.expectedTargetRevision, "目标知识"),
  };
}
