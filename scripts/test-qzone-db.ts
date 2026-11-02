import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import {
  claimPendingQzoneAction,
  checkQzoneQuota,
  createPendingQzoneAction,
  findPendingQzoneAction,
  finishQzoneAction,
  readQzoneUsage,
} from "../server/utils/channel-adapter/onebot/qzone";

/**
 * 空间草稿表的状态机回归（连真库）。
 *
 * 纯函数测不了这部分：认领是原子的、配额是按当天 PUBLISHED 行数算的，
 * 这两件事只有落到 Postgres 上才成立。用完自己清干净。
 */

const connectionId = randomUUID();

async function cleanup(): Promise<void> {
  await getPrisma().onebotQzoneAction.deleteMany({ where: { connectionId } });
}

async function main(): Promise<void> {
  await cleanup();

  // ── 1. 草稿生命周期 ────────────────────────────────────────
  const first = await createPendingQzoneAction({
    connectionId,
    characterId: randomUUID(),
    kind: "POST",
    content: "今天下雨了",
    topic: "今天下雨了",
    requestedBy: "10001",
    conversationKey: "c:10001",
  });
  assert.equal(first.kind, "POST");
  assert.equal(first.visible, 1, "默认公开可见（1）。");

  const pending = await findPendingQzoneAction(connectionId, "POST");
  assert.equal(pending?.id, first.id, "刚建的草稿必须能查到。");

  // 同连接同 kind 再来一次：旧草稿要被取消，不能两条都能被「确认」。
  const second = await createPendingQzoneAction({
    connectionId,
    characterId: randomUUID(),
    kind: "POST",
    content: "第二条",
    topic: "",
    requestedBy: "10001",
    conversationKey: "c:10001",
  });
  const afterSecond = await findPendingQzoneAction(connectionId, "POST");
  assert.equal(afterSecond?.id, second.id, "只应剩下最新那条草稿。");
  assert.equal(await claimPendingQzoneAction(first.id), false, "被取消的草稿不能再被认领。");

  // 重复投递的确认事件：第二次认领必须失败。
  assert.equal(await claimPendingQzoneAction(second.id), true, "第一次认领应该成功。");
  assert.equal(await claimPendingQzoneAction(second.id), false, "第二次认领必须失败 —— 否则会发两遍。");

  await finishQzoneAction(second.id, { ok: true, tid: "tid-1" });
  assert.equal(await findPendingQzoneAction(connectionId, "POST"), null, "发布后不该还有 PENDING。");

  // ── 2. 没有 tid 也算成功 ───────────────────────────────────
  const noTid = await createPendingQzoneAction({
    connectionId,
    characterId: randomUUID(),
    kind: "POST",
    content: "没 tid 那条",
    topic: "",
    requestedBy: "10001",
    conversationKey: "c:10001",
  });
  await claimPendingQzoneAction(noTid.id);
  await finishQzoneAction(noTid.id, { ok: true, tid: null });
  const usageAfter = await readQzoneUsage(connectionId);
  assert.equal(usageAfter.posts, 2, "没有 tid 也是成功，必须计入当天条数。");

  // ── 3. 配额 ───────────────────────────────────────────────
  const postQuota = await checkQzoneQuota(connectionId, "POST", {
    dailyPosts: 2,
    dailyComments: 8,
    commentCooldownMinutes: 30,
  });
  assert.equal(postQuota.allowed, false, "已经 2 条，上限 2 条，应该拦住。");
  assert.match((postQuota as { reason: string }).reason, /上限/u);

  const unlimited = await checkQzoneQuota(connectionId, "POST", {
    dailyPosts: 0,
    dailyComments: 0,
    commentCooldownMinutes: 0,
  });
  assert.equal(unlimited.allowed, true, "0 表示不限。");

  // ── 4. 评论冷却 ───────────────────────────────────────────
  const comment = await createPendingQzoneAction({
    connectionId,
    characterId: randomUUID(),
    kind: "COMMENT",
    content: "好可爱",
    topic: "评论第 1 条",
    requestedBy: "10001",
    conversationKey: "c:10001",
    targetUin: "123456",
    targetTid: "tid-a",
    targetExcerpt: "小鱼：今天下雨了",
  });
  const commentPending = await findPendingQzoneAction(connectionId, "COMMENT");
  assert.equal(commentPending?.targetUin, "123456", "评论草稿必须记住目标 QQ 与 tid。");
  assert.equal(commentPending?.targetTid, "tid-a");

  await claimPendingQzoneAction(comment.id);
  await finishQzoneAction(comment.id, { ok: true });
  const cooldown = await checkQzoneQuota(connectionId, "COMMENT", {
    dailyPosts: 3,
    dailyComments: 8,
    commentCooldownMinutes: 30,
  });
  assert.equal(cooldown.allowed, false, "刚评论过，冷却期必须拦住。");
  assert.match((cooldown as { reason: string }).reason, /冷却/u);

  await cleanup();
  console.log("qzone 草稿状态机回归通过：草稿替换 / 原子认领 / 无 tid 计成功 / 日上限 / 评论冷却");
}

main()
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch(() => undefined);
    await getPrisma().$disconnect().catch(() => undefined);
  });
