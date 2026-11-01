import { requireAdminActor } from "../../../utils/auth";
import { loadBiliCatalog } from "../../../utils/channel-adapter/bili/schema-catalog";

/**
 * 返回 B站命令目录，供 B站命令工作台前端渲染。
 * 优先读 `bili schema`（自动跟 CLI 版本走）；CLI 不可用时回退手写目录。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  return loadBiliCatalog();
});
