import { createHash } from "node:crypto";
import type { OnebotConnectionRecord } from "./configure";

export type OnebotRun = { stop: () => void; done: Promise<void> };

// Exclude runtime metadata/status; sort bindings so DB row order cannot trigger a reload.
function revision(record: OnebotConnectionRecord): string {
  return createHash("sha256").update(JSON.stringify({
    config: record.config,
    platform: record.platform,
    accountQq: record.accountQq,
    // 连接级默认值 + 群管理门；binding 里各自的覆盖值已经随 bindings 一起进了下面那份 JSON，
    // 任一变化都要让 runner 重载，否则页面保存了、进程还在用旧值。
    replyOnlyWhenMentioned: record.replyOnlyWhenMentioned,
    groupAnnouncementEnabled: record.groupAnnouncementEnabled,
    groupBiliRunEnabled: record.groupBiliRunEnabled,
    ownerQq: record.ownerQq,
    ownerName: record.ownerName,
    bindings: [...record.bindings].sort((a, b) => a.id.localeCompare(b.id)),
    reloadRequestedAt: record.reloadRequestedAt,
  })).digest("hex");
}

/** Caller serializes reconcile calls. Stop and await every replaced socket before re-reading. */
export function createOnebotRunner(options: {
  load: () => Promise<OnebotConnectionRecord[]>;
  start: (record: OnebotConnectionRecord) => OnebotRun;
  shouldStop: () => boolean;
}) {
  const active = new Map<string, { revision: string; run: OnebotRun }>();
  return {
    async reconcile() {
      const records = await options.load();
      const wanted = new Map(records.map((record) => [record.id, revision(record)]));
      const removed = [...active].filter(([id, entry]) => wanted.get(id) !== entry.revision);
      for (const [, entry] of removed) entry.run.stop();
      await Promise.all(removed.map(async ([id, entry]) => {
        await entry.run.done;
        active.delete(id);
      }));
      // A save/reload can arrive while the previous WS is closing. Never start the old snapshot.
      const latest = removed.length ? await options.load() : records;
      for (const record of latest) {
        if (options.shouldStop()) break;
        if (!active.has(record.id)) {
          active.set(record.id, { revision: revision(record), run: options.start(record) });
        }
      }
    },
    async stop() {
      for (const entry of active.values()) entry.run.stop();
      await Promise.all([...active.values()].map((entry) => entry.run.done));
      active.clear();
    },
  };
}
