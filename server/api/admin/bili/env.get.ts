import { requireAdminActor } from "../../../utils/auth";
import { biliInstallCommand, probeBiliBin, runBili } from "../../../utils/channel-adapter/bili/runner";

/**
 * B站值班台的运行环境：bili CLI 装了没、装在哪、什么版本。
 *
 * 为什么单独一个接口而不是并进 dashboard：缺 CLI 时 dashboard 只是「空」，空得
 * 和「刚建好还没跑过」一模一样。前端要靠这条来判断该不该顶一条「先装 CLI」的横幅，
 * 而不是让人对着空页面猜。
 *
 * 刻意不接 connectionId：这里回答的是「这台机器能不能跑 bili」，
 * 属于进程级事实，不随某个账号的配置变化。
 */
type BiliCliEnv = {
  installed: boolean;
  bin: string;
  source: "connection" | "env" | "venv" | "path" | "missing";
  version: string | null;
  installCommand: string;
};

// --version 要起一次 Python，几百毫秒。页面切来切去没必要每次再起，
// 但也不能一直缓存 —— 用户可能刚装完就点「重新检测」。
const VERSION_TTL_MS = 60_000;
let versionCache: { bin: string; at: number; version: string | null } | null = null;

async function readVersion(bin: string): Promise<string | null> {
  if (versionCache && versionCache.bin === bin && Date.now() - versionCache.at < VERSION_TTL_MS) {
    return versionCache.version;
  }
  const result = await runBili(["--version"], { bin, timeoutMs: 20_000 });
  let version: string | null = null;
  try {
    const parsed = JSON.parse(result.stdout) as { ok?: boolean; data?: { version?: string } };
    version = parsed.ok ? (parsed.data?.version ?? null) : null;
  } catch {
    // 输出不是 JSON：多半不是 bili-agent 装出来的那个 bili，算「认不出」而不是「没装」
    version = null;
  }
  versionCache = { bin, at: Date.now(), version };
  return version;
}

export default defineEventHandler(async (event) => {
  await requireAdminActor(event);

  const probe = probeBiliBin();
  const payload: BiliCliEnv = {
    installed: probe.found,
    bin: probe.bin,
    source: probe.source,
    version: null,
    installCommand: biliInstallCommand(),
  };
  if (probe.found) payload.version = await readVersion(probe.bin);
  return payload;
});
