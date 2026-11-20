import { executeBrowserActions, parseBrowserActions, parseBrowserProposal } from "./browser-actions";
import { auditLocalObserve, LocalObserveError } from "./local-observe";
import { appendBrowserEvidence, attachContinuationBrowser, lockLocalTaskForApproval } from "./local-tasks";
import { getPrisma } from "./prisma";
import { validatePublicWebpageUrl } from "./read-public-webpage";

export type LocalBrowserInput = {
  url: string;
  actions: unknown;
  reason: string;
  actorId: string;
  characterId?: string;
  conversationId?: string;
  taskId?: string;
  /** Continuation mode: record this action as the task's next step. */
  attachStep?: boolean;
};

function normalizeUrl(input: unknown) {
  if (typeof input !== "string" || !input.trim()) throw new LocalObserveError(400, "网页操作必须指定网址。");
  try {
    return validatePublicWebpageUrl(input.trim()).toString();
  } catch {
    throw new LocalObserveError(400, "只支持公开网站地址，不允许本机、私网、凭据或自定义端口。");
  }
}

export async function createLocalBrowserRequest(input: LocalBrowserInput) {
  const url = normalizeUrl(input.url);
  let proposal;
  try {
    proposal = parseBrowserProposal(input.actions);
  } catch (error) {
    throw new LocalObserveError(400, error instanceof Error ? error.message : "网页操作步骤无效。");
  }
  const { actions, submitSelector } = proposal;
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "";
  if (!reason) throw new LocalObserveError(400, "网页操作必须说明原因。");
  const request = await getPrisma().$transaction(async tx => {
    await lockLocalTaskForApproval(tx, input.taskId, input.actorId);
    // The same steps on the same page, still awaiting approval, are one request — not a queue of duplicates.
    const duplicate = await tx.localBrowserRequest.findFirst({
      where: { actorId: input.actorId, url, actions: { equals: actions }, submitSelector, status: { in: ["PENDING", "APPROVING", "FILLED"] } },
      select: { id: true },
    });
    if (duplicate) throw new LocalObserveError(409, "这项相同的网页操作已经在等待批准，不要重复提交。");
    const created = await tx.localBrowserRequest.create({ data: {
      url,
      actions,
      submitSelector,
      reason,
      actorId: input.actorId,
      ...(input.characterId ? { characterId: input.characterId } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
    } });
    if (input.attachStep && input.taskId) {
      await attachContinuationBrowser(tx, input.taskId, created.id, new URL(url).pathname || "/");
    }
    return created;
  });
  auditLocalObserve(input.actorId, "browser.request", { requestId: request.id, origin: new URL(url).origin, steps: actions.length });
  return request;
}

export async function listLocalBrowserRequests(status = "PENDING") {
  return await getPrisma().localBrowserRequest.findMany({
    where: status ? { status } : {}, orderBy: [{ createdAt: "desc" }], take: 50,
  });
}

export async function getLocalBrowserRequest(id: string) {
  const request = await getPrisma().localBrowserRequest.findUnique({ where: { id } });
  if (!request) throw new LocalObserveError(404, "网页操作请求不存在。");
  return request;
}

export async function approveLocalBrowserRequest(id: string, actorId: string) {
  const request = await getLocalBrowserRequest(id);
  if (request.status !== "PENDING") throw new LocalObserveError(409, "这个请求已经处理过了。");
  const actions = parseBrowserActions(request.actions);
  const url = normalizeUrl(request.url);
  await getPrisma().$transaction(async tx => {
    await lockLocalTaskForApproval(tx, request.taskId);
    const claimed = await tx.localBrowserRequest.updateMany({
      where: { id, taskId: request.taskId, status: "PENDING" },
      data: { status: "APPROVING", decidedAt: new Date() },
    });
    if (claimed.count !== 1) throw new LocalObserveError(409, "这个请求正在被处理。");
  });
  const submitSelector = request.submitSelector ?? null;
  try {
    // Phase one never submits: a filled form stops at FILLED and waits for a second, separate confirmation.
    const result = await executeBrowserActions(url, actions);
    // The screenshot is for the approver's eyes only; keep the row small and text-based.
    const { screenshot, ...stored } = result;
    const status = result.steps.some(step => !step.ok) ? "FAILED" : submitSelector ? "FILLED" : "SUCCEEDED";
    const updated = await getPrisma().localBrowserRequest.update({
      where: { id },
      data: { status, result: stored, finishedAt: status === "FILLED" ? null : new Date(),
        ...(status === "FAILED" ? { error: result.steps.find(step => !step.ok)?.detail?.slice(0, 500) ?? "执行失败" } : {}) },
    });
    if (request.taskId && status !== "FILLED") {
      await appendBrowserEvidence({
        taskId: request.taskId, outcome: status === "SUCCEEDED" ? "PASS" : "FAIL", actorId,
        note: [browserEvidenceNote(url, result), submitSelector ? "尚未提交，等待再次确认。" : ""].filter(Boolean).join("\n"),
      });
    }
    auditLocalObserve(actorId, "browser.apply", { requestId: id, status, steps: result.steps.length });
    return { ...updated, screenshot };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await getPrisma().localBrowserRequest.update({
      where: { id }, data: { status: "FAILED", error: message.slice(0, 500), finishedAt: new Date() },
    }).catch(() => {});
    auditLocalObserve(actorId, "browser.apply", { requestId: id, status: "failed", error: message.slice(0, 300) });
    if (error instanceof LocalObserveError) throw error;
    throw new LocalObserveError(500, `网页操作失败：${browserErrorMessage(message)}`);
  }
}

/** Phase two: the only path that lets a same-origin form actually post. */
export async function submitLocalBrowserRequest(id: string, actorId: string) {
  const request = await getLocalBrowserRequest(id);
  if (request.status !== "FILLED") throw new LocalObserveError(409, "这项申请还没有填好，或者已经处理过了。");
  const submitSelector = request.submitSelector;
  if (!submitSelector) throw new LocalObserveError(409, "这项申请没有提交步骤。");
  const actions = parseBrowserActions(request.actions);
  const url = normalizeUrl(request.url);
  await getPrisma().$transaction(async tx => {
    await lockLocalTaskForApproval(tx, request.taskId);
    const claimed = await tx.localBrowserRequest.updateMany({
      where: { id, taskId: request.taskId, status: "FILLED" },
      data: { status: "APPROVING", decidedAt: new Date() },
    });
    if (claimed.count !== 1) throw new LocalObserveError(409, "这个请求正在被处理。");
  });
  try {
    const result = await executeBrowserActions(url, actions, submitSelector);
    const { screenshot, ...stored } = result;
    const status = result.submitted ? "SUCCEEDED" : "FAILED";
    const updated = await getPrisma().localBrowserRequest.update({
      where: { id },
      data: { status, result: stored, finishedAt: new Date(),
        ...(status === "FAILED" ? { error: result.steps.find(step => !step.ok)?.detail?.slice(0, 500) ?? "提交失败" } : {}) },
    });
    if (request.taskId) {
      await appendBrowserEvidence({
        taskId: request.taskId, outcome: status === "SUCCEEDED" ? "PASS" : "FAIL", actorId,
        note: browserEvidenceNote(url, result),
      });
    }
    auditLocalObserve(actorId, "browser.apply", { requestId: id, status, submitted: result.submitted });
    return { ...updated, screenshot };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await getPrisma().localBrowserRequest.update({
      where: { id }, data: { status: "FAILED", error: message.slice(0, 500), finishedAt: new Date() },
    }).catch(() => {});
    auditLocalObserve(actorId, "browser.apply", { requestId: id, status: "failed", error: message.slice(0, 300) });
    if (error instanceof LocalObserveError) throw error;
    throw new LocalObserveError(500, `网页提交失败：${browserErrorMessage(message)}`);
  }
}

function browserEvidenceNote(url: string, result: { steps: { ok: boolean; action: string; detail?: string }[]; title: string; blockedRequests: number; submitted?: boolean }) {
  return [`网页：${url}`,
    ...result.steps.map(step => `${step.ok ? "✓" : "✗"} ${step.action}${step.detail ? `（${step.detail}）` : ""}`),
    `页面标题：${result.title || "(无)"}`, `已阻止 ${result.blockedRequests} 个请求`, result.submitted ? "已提交表单。" : ""]
    .filter(Boolean).join("\n");
}

export async function rejectLocalBrowserRequest(id: string, actorId: string, reason = "") {
  const request = await getLocalBrowserRequest(id);
  // A filled-but-unconfirmed form can still be refused; it simply never gets submitted.
  if (request.status !== "PENDING" && request.status !== "FILLED") throw new LocalObserveError(409, "这个请求已经处理过了。");
  const updated = await getPrisma().localBrowserRequest.updateMany({
    where: { id, status: { in: ["PENDING", "FILLED"] } },
    data: { status: "REJECTED", decidedAt: new Date(), error: reason.trim().slice(0, 500) || null },
  });
  if (updated.count !== 1) throw new LocalObserveError(409, "这个请求正在被处理。");
  auditLocalObserve(actorId, "browser.reject", { requestId: id });
  return await getLocalBrowserRequest(id);
}

/** Human-readable refusals for the operator; never echo page content back. */
export function browserErrorMessage(code: string) {
  const messages: Record<string, string> = {
    BROWSER_NOT_INSTALLED: "未找到 Chrome 或 Edge，请先在本机安装浏览器。",
    BROWSER_BUSY: "另一个浏览器会话正在进行，请稍后重试。",
    BROWSER_TIMEOUT: "网页操作超时，独立浏览器已关闭。",
    BROWSER_ORIGIN_NOT_AUTHORIZED: "操作过程中页面试图跳转或加载其他网站，已阻止。",
    WEB_INVALID_URL: "只支持公开网站地址。",
    WEB_BLOCKED_HOST: "该网址解析到非公开网络，已阻止。",
    BROWSER_ACTIONS_INVALID: "网页操作步骤无效。",
  };
  return messages[code] ?? "独立浏览器会话已关闭。";
}
