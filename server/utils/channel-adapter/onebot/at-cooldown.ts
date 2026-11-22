/** 群提醒节流：按发送身份、群和收件人隔离；只有成功发送才进入十分钟冷却。 */
export const GROUP_AT_COOLDOWN_MS = 10 * 60_000;
const lastAtByKey = new Map<string, number>();
const pending = new Map<string, symbol>();

export function groupAtKey(sender: string, group: string, qq: string): string {
  return JSON.stringify([sender, group, qq]);
}

/** 同步预约防止并发穿透；调用方必须在发送成功后 commit，失败后 release。 */
export function claimGroupAt(key: string, now = Date.now(), cooldownMs = GROUP_AT_COOLDOWN_MS) {
  for (const [entry, at] of lastAtByKey) {
    if (now - at >= cooldownMs) lastAtByKey.delete(entry);
  }
  const previous = lastAtByKey.get(key);
  if (pending.has(key) || (previous !== undefined && now - previous < cooldownMs)) {
    return { allowed: false as const, sinceMs: previous === undefined ? 0 : now - previous };
  }
  const token = Symbol();
  pending.set(key, token);
  return {
    allowed: true as const,
    commit(sentAt = Date.now()) {
      if (pending.get(key) !== token) return;
      pending.delete(key);
      lastAtByKey.set(key, sentAt);
    },
    release() {
      if (pending.get(key) === token) pending.delete(key);
    },
  };
}

export function resetGroupAtCooldown(): void {
  lastAtByKey.clear();
  pending.clear();
}
