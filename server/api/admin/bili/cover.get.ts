import { createError, getQuery } from "h3";
import { requireAdminActor } from "../../../utils/auth";

/**
 * 返回某个 BV 号的视频封面图片地址（B站公开 view 接口的 pic 字段），供 B站工作台
 * 「她今天看了什么」列表展示封面。只返回 pic 的 URL，图片字节由浏览器直连 B站 CDN 加载，
 * 不在服务端缓存二进制。
 */

const picCache = new Map<string, string>();
const PIC_CACHE_MAX = 800;

async function resolvePic(bvid: string): Promise<string | null> {
  const cached = picCache.get(bvid);
  if (cached !== undefined) return cached || null;

  let pic: string | null = null;
  try {
    const response = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
      headers: { "user-agent": "Mozilla/5.0", referer: "https://www.bilibili.com/" },
    });
    if (response.ok) {
      const payload = await response.json() as { code?: number; data?: { pic?: unknown } };
      if (payload.code === 0 && typeof payload.data?.pic === "string") {
        pic = payload.data.pic;
        if (pic.startsWith("//")) pic = "https:" + pic;
      }
    }
  } catch {
    pic = null;
  }

  if (picCache.size >= PIC_CACHE_MAX) picCache.clear();
  picCache.set(bvid, pic ?? "");
  return pic;
}

export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const bvid = getQuery(event).bvid;
  if (typeof bvid !== "string" || !/^BV[0-9A-Za-z]{10}$/.test(bvid.trim())) {
    throw createError({ statusCode: 400, statusMessage: "缺少合法的 bvid 参数。" });
  }
  const pic = await resolvePic(bvid.trim());
  return { bvid: bvid.trim(), pic };
});
