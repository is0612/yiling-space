/**
 * QQ 渠道链路轨的纯逻辑。
 *
 * 单独放在这里而不是写在组件的 computed 里，是因为「断在哪一环」这条判断
 * 是这一屏唯一会出错的地方，而它又完全取决于四个布尔值 —— 没有理由为了测它去挂 DOM。
 */

/**
 * 链路轨上的修复动作。
 *
 * 断点只有一个，所以动作也只有一个 —— 这里用联合类型而不是三个布尔 prop，
 * 免得将来出现「同时显示启动网关和绑定角色」这种自相矛盾的状态。
 */
export type ChainActionKind =
  | "start-gateway"
  | "start-adapter"
  | "bind-character"
  | "edit-connection"
  | "reconnect"
  | "stop"
  | "open-steps";

/** live=通了；break=断点本人；idle=没通但不是根因（或还没轮到） */
export type ChainTone = "live" | "break" | "idle";

export type ChainConditions = {
  /** 小号的连接状态是 CONNECTED */
  accountOk: boolean;
  /** 网关端口有人监听 */
  gatewayOk: boolean;
  /** 适配器进程在跑 */
  adapterOk: boolean;
  /** 至少绑了一个角色 */
  bindingOk: boolean;
};

/**
 * 挑出「根因」那一段，返回显示顺序里的下标：0 小号 / 1 网关 / 2 适配器 / 3 角色。
 * 全通返回 -1。
 *
 * **按因果挑，不按显示顺序挑。** 显示顺序是消息流向（小号 → 网关 → 适配器 → 角色），
 * 但依赖关系反过来：网关不起，适配器就连不上；适配器不跑，小号的 status 根本没人维护
 * （platform_connections.status 只有适配器会写，进程一停就停在最后那个值上）。
 *
 * 所以先看网关，再看适配器，最后才轮到小号 —— 否则适配器没启动时会先报「小号未连接」，
 * 把人指去重新登录 QQ，而他要做的其实是点一下「启动适配器」。
 */
export function resolveChainRoot(conditions: ChainConditions): number {
  if (!conditions.gatewayOk) return 1;
  if (!conditions.adapterOk) return 2;
  if (!conditions.accountOk) return 0;
  if (!conditions.bindingOk) return 3;
  return -1;
}

/**
 * 每一段的成色。
 *
 * 断点之后一律 idle：那几段现在的状态没有意义（网关没开时「有没有绑角色」不影响任何事），
 * 照着标红只会让人同时看到三个红点，反而分不清该修哪个。
 */
export function chainToneAt(index: number, root: number, ok: boolean): ChainTone {
  if (root === -1) return ok ? "live" : "idle";
  if (index === root) return "break";
  if (index > root) return "idle";
  return ok ? "live" : "idle";
}
