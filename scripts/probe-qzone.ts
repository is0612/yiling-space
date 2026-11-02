import "dotenv/config";
import { loadOnebotConnections } from "../server/utils/channel-adapter/onebot/configure";
import { callOnebotAction, getOnebotCookies } from "../server/utils/channel-adapter/onebot/client";
import {
  buildQzoneCredential,
  commentQzoneFeed,
  computeQzoneGtk,
  listQzoneMoods,
  parseQzoneCookieString,
  publishQzonePost,
  readQzoneFriendQqs,
  type QzoneFeed,
} from "../server/utils/channel-adapter/onebot/qzone";

/**
 * 探针：摸清这条「协议端 → QQ 空间」的通道到底通不通。
 *
 * 为什么必须有这一步：空间的接口全是逆向来的，各家协议端的扩展动作名、参数名、
 * 返回结构都可能不一样。照着文档猜会得到一串 `-10001`，而它不告诉你哪个字段错了。
 *
 * 默认**只读**，不动账号：
 *   yarn probe:qzone
 *   yarn probe:qzone --connection=<连接 id>
 *
 * 要验证写操作，显式加参数（会真的发到空间上）：
 *   yarn probe:qzone --post --content="测试一条，马上删"     # 发一条说说，可见范围=仅自己
 *   yarn probe:qzone --comment-test --index=1                # 评论列表里第 1 条
 *
 * 设计上刻意让写操作「默认仅自己可见」：探针失败了也不至于让朋友看到一堆测试内容。
 */

function arg(name: string): string | undefined {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** 凭据只打「有没有、多长」，绝不把 p_skey 打出来。 */
function maskSecret(value: string): string {
  if (!value) return "(空)";
  if (value.length <= 8) return `${value.slice(0, 2)}***(${value.length})`;
  return `${value.slice(0, 4)}***${value.slice(-2)}(${value.length})`;
}

function print(label: string, payload: unknown): void {
  console.log(`\n=== ${label} ===`);
  console.log(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2));
}

async function main(): Promise<void> {
  const records = await loadOnebotConnections();
  if (!records.length) {
    console.error("没有可用的 QQ 连接。先在「系统管理 → QQ 渠道」里建一个。");
    process.exitCode = 1;
    return;
  }
  const wanted = arg("connection");
  const record = wanted ? records.find((item) => item.id === wanted) : records[0];
  if (!record) {
    console.error(`找不到连接 ${wanted}。`);
    process.exitCode = 1;
    return;
  }

  console.log(`连接：${record.id}`);
  console.log(`小号：${record.accountQq || "(未填)"}`);
  console.log(`HTTP：${record.config.httpUrl}`);
  console.log(`空间开关：${record.qzoneEnabled ? "开" : "关"}（探针不受开关限制，但正式用要先打开）`);
  console.log(`主人 QQ：${record.ownerQq || "(未填，空间指令不会生效)"}`);
  console.log(`名单：${record.qzoneFriendQqs.join(",") || "(空，会退回好友列表前几个)"}`);

  // ── 1. 协议端活着吗 ──────────────────────────────────────
  for (const action of ["get_login_info", "get_status", "get_version_info"]) {
    try {
      const data = await callOnebotAction(record.config, action, {});
      print(action, data ?? "(空)");
    } catch (error) {
      print(`${action} 失败`, error instanceof Error ? error.message : String(error));
    }
  }

  // ── 2. 拿得到空间 cookie 吗（评论/列表全靠它） ────────────
  let cookie = "";
  try {
    cookie = await getOnebotCookies(record.config, "qzone.qq.com");
    const pairs = parseQzoneCookieString(cookie);
    print("get_cookies(qzone.qq.com)", {
      cookieLength: cookie.length,
      keys: Object.keys(pairs).sort(),
      uin: maskSecret(pairs.uin ?? pairs.p_uin ?? ""),
      p_skey: maskSecret(pairs.p_skey ?? ""),
      skey: maskSecret(pairs.skey ?? ""),
      g_tk: computeQzoneGtk(pairs.p_skey ?? pairs.skey ?? ""),
    });
  } catch (error) {
    print("get_cookies 失败", error instanceof Error ? error.message : String(error));
    console.log("→ 协议端可能没实现 get_cookies。退路：把浏览器里的 cookie 填进环境变量 QZONE_COOKIE。");
  }

  const credential = buildQzoneCredential(cookie);
  if (!credential) {
    console.log("\n→ 没有可用的空间凭证，后面的说说列表/评论探测全部跳过。");
  } else {
    console.log(`\n凭证解析成功：uin=${credential.uin}，g_tk=${credential.gtk}`);
  }

  if (credential) {
    // ── 3. 好友列表（命令名单的来源） ──────────────────────
    const friends = await readQzoneFriendQqs(record.config, 5, record.accountQq ? [record.accountQq] : []);
    print(`get_friend_list（前 ${friends.length} 个）`, friends);
    if (!friends.length) {
      console.log("→ 拿不到好友列表。名单请在连接设置里手填，或者直接说「看看 123456 的空间」。");
    }

    // ── 4. 说说列表（只读，评论的前提） ────────────────────
    const targets = [
      { uin: credential.uin, label: "她自己" },
      ...(record.qzoneFriendQqs.length
        ? record.qzoneFriendQqs.slice(0, 2).map((uin) => ({ uin, label: "名单好友" }))
        : friends.slice(0, 2).map((friend) => ({ uin: friend.uin, label: "好友列表" }))),
    ];
    const collected: QzoneFeed[] = [];
    for (const target of targets) {
      try {
        const moods = await listQzoneMoods(record.config, target.uin, 3);
        print(`${target.label} ${target.uin} 的说说`, moods);
        collected.push(...moods);
      } catch (error) {
        print(`${target.label} ${target.uin} 失败`, error instanceof Error ? error.message : String(error));
        console.log("→ -3000 = 登录态过期；-10001 = 参数不对；空列表 = 对方没有可见说说。");
      }
    }
    if (!collected.length) {
      console.log("\n→ 一条说说都没拿到，评论功能没法验证 —— 先解决列表这一步。");
    }

    // ── 5. 评论（写，默认不评） ────────────────────────────
    if (flag("comment-test")) {
      const index = Number(arg("index") ?? "1");
      const target = collected[index - 1];
      if (!target) {
        console.log(`\n没有第 ${index} 条说说，评论测试跳过。`);
      } else {
        print("评论目标", target);
        try {
          await commentQzoneFeed(record.config, {
            targetUin: target.uin,
            tid: target.tid,
            content: arg("text") ?? "测试评论，稍后删除。",
          });
          console.log("\n→ 接口返回 code=0。去空间看一眼有没有真的出现 —— 接口成功不等于评论可见。");
        } catch (error) {
          print("评论失败", error instanceof Error ? error.message : String(error));
          console.log("→ -10001 = 参数不对（topicId / hostUin 最可能）；-3000 = 登录态过期。");
        }
      }
    } else {
      console.log("（跳过评论。要实测加 --comment-test --index=1，会对真实说说发一条测试评论。）");
    }
  }

  // ── 6. 发说说（写，默认不发） ─────────────────────────────
  if (flag("post")) {
    const content = arg("content") ?? "测试一条，稍后删除。";
    try {
      // 探针默认只发「仅自己可见」：发出去也不打扰别人，删起来也方便。
      const result = await publishQzonePost(record.config, { content, visible: 64 });
      print("send_qzone_msg / 发说说", result);
      if (!result.tid) {
        console.log("→ 没有 tid。**别重试**，先去空间看一眼到底发出去没有。");
      }
    } catch (error) {
      print("发说说失败", error instanceof Error ? error.message : String(error));
      console.log("→ 若报「不支持 / 404」，说明协议端没有 send_qzone_msg，代码会自动降级到网页 CGI；"
        + " 两边都失败就该检查登录态了。");
    }
  } else {
    console.log("\n（跳过发说说。要实测加 --post，默认仅自己可见。）");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
