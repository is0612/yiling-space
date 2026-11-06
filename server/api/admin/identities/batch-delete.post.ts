import { createError, readBody } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { deleteFriendScope } from "../../../utils/friend-delete";

/** 一页最多 12 个人，留出余量；再多的就是脚本该干的事，不该走这个接口。 */
const MAX_BATCH = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 批量删朋友：把选中的几条关系一次删掉。
 *
 * 每条各走一遍 `deleteFriendScope`（各自的语义和审计都在那里），**不是**一个大事务：
 * 删 12 个人时中间有一条失败，前面已经删掉的不该被回滚 —— 那样用户会看到「一个人都没删」
 * 但列表空了。所以这里逐条执行、逐条记账，把失败的 scopeId 原样带回去。
 *
 * 失败文案只用固定句：数据库报错不该出现在前端（可能带表名或字段名）。
 */
export default defineEventHandler(async (event) => {
  const actor = await requireAdminActor(event);
  const body = await readBody<{ scopeIds?: unknown }>(event).catch(() => null);
  const raw = body?.scopeIds;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw createError({ statusCode: 400, statusMessage: "至少选择一个人。" });
  }

  // 去重：同一个 id 重复提交会让第二条变成「不存在」，白白记一次失败。
  const scopeIds = [...new Set(raw.filter((item): item is string => typeof item === "string"))];
  if (scopeIds.length === 0) {
    throw createError({ statusCode: 400, statusMessage: "要删除的人无效。" });
  }
  if (scopeIds.length > MAX_BATCH) {
    throw createError({ statusCode: 400, statusMessage: `一次最多删 ${MAX_BATCH} 个人。` });
  }

  let deleted = 0;
  let conversations = 0;
  let messages = 0;
  let memoryItems = 0;
  const failures: string[] = [];

  for (const scopeId of scopeIds) {
    if (!UUID_PATTERN.test(scopeId)) {
      failures.push(scopeId);
      continue;
    }
    try {
      const outcome = await deleteFriendScope({ scopeId, actorId: actor.user.id });
      if (!outcome) {
        failures.push(scopeId);
        continue;
      }
      deleted += 1;
      conversations += outcome.deleted.conversations;
      messages += outcome.deleted.messages;
      memoryItems += outcome.deleted.memoryItems;
    } catch {
      failures.push(scopeId);
    }
  }

  return {
    ok: failures.length === 0,
    deleted,
    failed: failures.length,
    /** 只回 id，前端本来就知道有哪些人，不需要再回一份名字。 */
    failedScopeIds: failures,
    purged: { conversations, messages, memoryItems },
  };
});
