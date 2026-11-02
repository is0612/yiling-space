import { requireAdminActor } from "../../../../../utils/auth";
import { loadOnebotConnections } from "../../../../../utils/channel-adapter/onebot/configure";
import { readSnowlumaStatus } from "../../../../../utils/channel-adapter/onebot/runtime";

/**
 * 把「面板密码」单独亮出来给管理页看。
 *
 * 为什么单独一个接口，而不是塞进 runtime 轮询里：runtime 是每几秒拉一次的，
 * 明文密码跟着高频轮询跑没有意义，也容易被日志/缓存捡走。这里只在页面打开、
 * 以及「一键启动」刚接管完密码时各取一次。
 *
 * 值来自连接凭据（`snowlumaPassword`），也就是「连接设置」里那一格 —— 同一份数据，
 * 不存在第二个真相。密码是忆灵空间在全新安装时替 SnowLuma 生成的（人从没手抄过），
 * 不显示出来，用户就没有任何途径知道它、更谈不上换成自己记得住的。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);

  const [status, records] = await Promise.all([
    readSnowlumaStatus(),
    // 读不出连接（凭据解不开等）不该让「看密码」整个 500：给空值，页面提示去连接设置重填。
    loadOnebotConnections().catch(() => []),
  ]);
  const record = records.find((item) => item.snowlumaPassword) ?? records[0];

  return {
    /** null = 还没有连接，或那份凭据解不开（页面据此提示重新填） */
    password: record?.snowlumaPassword || null,
    /** 这串密码属于哪个 QQ 号，多号时人能对上是哪一个 */
    accountQq: record?.accountQq ?? "",
    panelPort: status.panelPort,
    panelUrl: `http://127.0.0.1:${status.panelPort}`,
    snowlumaRunning: status.running,
  };
});
