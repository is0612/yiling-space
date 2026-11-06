import { randomUUID } from "node:crypto";
import type { getPrisma } from "../../prisma";

type BiliDutyPrisma = ReturnType<typeof getPrisma>;

/**
 * bili CLI 单次写操作默认超时 4 分钟。租约 6 分钟，既覆盖一个正在执行的写命令，
 * 也能在适配器进程异常退出后自动回收；正常长轮次靠心跳续租。
 */
export const BILI_DUTY_LEASE_TTL_MS = 6 * 60 * 1000;
export const BILI_DUTY_LEASE_HEARTBEAT_MS = 30 * 1000;

export class BiliDutyLeaseLostError extends Error {
  constructor(message = "B站值班执行租约已失效；为避免重复操作，本轮已停止后续动作。") {
    super(message);
    this.name = "BiliDutyLeaseLostError";
  }
}

export type BiliDutyLease = {
  token: string;
  /** 外部写操作前必须调用；同时确认 token 仍归本轮持有并续租。 */
  assertOwned: () => Promise<void>;
  /** 只释放自己的 token；租约已经丢失时不主动删除，让它自然过期。 */
  release: () => Promise<boolean>;
};

/**
 * 数据库原子认领：不存在时 INSERT；存在但过期时条件 UPDATE；仍有效时返回空。
 * ON CONFLICT 的条件更新在 PostgreSQL 行锁内判断，两个不同进程不能同时认领。
 */
export async function acquireBiliDutyLease(
  prisma: BiliDutyPrisma,
  bindingId: string,
): Promise<BiliDutyLease | null> {
  const token = randomUUID();
  const claimed = await prisma.$queryRaw<Array<{ bindingId: string }>>`
    INSERT INTO "bili_duty_leases"
      ("bindingId", "token", "expiresAt", "createdAt", "updatedAt")
    VALUES (
      CAST(${bindingId} AS uuid),
      CAST(${token} AS uuid),
      NOW() + (${BILI_DUTY_LEASE_TTL_MS} * INTERVAL '1 millisecond'),
      NOW(),
      NOW()
    )
    ON CONFLICT ("bindingId") DO UPDATE
    SET
      "token" = EXCLUDED."token",
      "expiresAt" = EXCLUDED."expiresAt",
      "updatedAt" = NOW()
    WHERE "bili_duty_leases"."expiresAt" <= NOW()
    RETURNING "bindingId"
  `;
  if (claimed.length !== 1) return null;

  let released = false;
  let lostError: BiliDutyLeaseLostError | null = null;
  let renewal: Promise<void> | null = null;

  const markLost = (error: unknown): BiliDutyLeaseLostError => {
    if (!lostError) {
      const detail = error instanceof Error ? error.message : String(error);
      lostError = new BiliDutyLeaseLostError(
        detail ? `B站值班租约续期/校验失败（${detail}）；为避免重复操作，本轮已停止后续动作。` : undefined,
      );
      console.error("[bili] 值班执行租约丢失，停止后续写操作。", detail);
    }
    return lostError;
  };

  const renew = (): Promise<void> => {
    if (released) return Promise.reject(new BiliDutyLeaseLostError("B站值班租约已释放。"));
    if (lostError) return Promise.reject(lostError);
    if (renewal) return renewal;

    renewal = (async () => {
      const rows = await prisma.$queryRaw<Array<{ bindingId: string }>>`
        UPDATE "bili_duty_leases"
        SET
          "expiresAt" = NOW() + (${BILI_DUTY_LEASE_TTL_MS} * INTERVAL '1 millisecond'),
          "updatedAt" = NOW()
        WHERE
          "bindingId" = CAST(${bindingId} AS uuid)
          AND "token" = CAST(${token} AS uuid)
          AND "expiresAt" > NOW()
        RETURNING "bindingId"
      `;
      if (rows.length !== 1) {
        throw new BiliDutyLeaseLostError();
      }
    })()
      .catch((error: unknown) => {
        throw markLost(error);
      })
      .finally(() => {
        renewal = null;
      });
    return renewal;
  };

  const timer = setInterval(() => {
    void renew().catch(() => undefined);
  }, BILI_DUTY_LEASE_HEARTBEAT_MS);
  timer.unref?.();

  return {
    token,
    assertOwned: renew,
    release: async () => {
      if (released) return false;
      released = true;
      clearInterval(timer);
      if (renewal) await renewal.catch(() => undefined);
      // A lost lease may already belong to a new runner. Leave its row alone.
      if (lostError) return false;
      const rows = await prisma.$queryRaw<Array<{ bindingId: string }>>`
        DELETE FROM "bili_duty_leases"
        WHERE
          "bindingId" = CAST(${bindingId} AS uuid)
          AND "token" = CAST(${token} AS uuid)
        RETURNING "bindingId"
      `;
      return rows.length === 1;
    },
  };
}
