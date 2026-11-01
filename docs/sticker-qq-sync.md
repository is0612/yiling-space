# 表情包与 QQ 收藏夹的双向同步

目标是一句话：**两边是同一批表情，一边改了另一边跟着变，一边删了另一边也没了。**

代码：`server/utils/qq-custom-face.ts`（接口封装）、`server/utils/qq-sticker-sync.ts`（对账 + 编排）、`app/pages/characters/[id]/settings/stickers.vue`（界面）。

---

## 1. 为什么要做

原来两边互不相干：

- 她在 QQ 里收藏的表情，本地看不到，挑图时也用不上；
- 本地上传/偷来的图，QQ 收藏夹里没有；
- 任何一边删掉，另一边还留着，久了就是两批对不上的表情。

用户的原话是「她自己加了表情，但打标签可能打不准，我们这边可以改，然后两边的表情是同步的」——
所以本地不是 QQ 的镜像，而是**同一份数据的两端**：本地打标、QQ 提供收藏这个容器。

## 2. 接口事实（实测，不是文档抄的）

四个 action 全是 SnowLuma 的扩展，OneBot v11 标准里没有。`yarn probe:custom-face --flow` 走了一遍
「加一张 → 改备注 → 回查 → 删掉」，结果如下：

| action | 参数 | 返回 / 行为 |
| --- | --- | --- |
| `fetch_custom_face_detail` | `{ count }` | `data: [{ emoji_id, resId, url, md5, desc }]`；`url` 可直接下载 |
| `add_custom_face` | `{ file: "base64://…", is_origin }` | **回传 `emoji_id`** |
| `modify_custom_face` | `{ emoji_id, desc }` | 改备注，回查确认生效 |
| `delete_custom_face` | `{ emoji_id }` | 真删（条数 1 → 0） |

两个坑：

1. **HTTP 200 不代表成功**。错误在 `retcode` 里；不认识的 action 回 `retcode: 1404` + `"unknown action"`。
   不判 `retcode` 就会把「这个网关没有收藏表情接口」读成「收藏夹是空的」——然后安全阀就会介入，
   用户看到的是「同步不动」，而不是「你用的是 NapCat，没有这个接口」。
2. **`resId` 不是 url**。SnowLuma 把它一起返回了，长得像 id；`url` 才是能下载的那个（qpic，带时效 rkey，过期就 403）。

`emoji_id` 的格式是 `<QQ号>_0_0_0_<md5>_0_0`，第 5 段就是图片的 md5。这是**免费的内容指纹**。

## 3. 怎么把两边认成同一张

`character_stickers` 上加了两个字段：

- `qqEmojiId` —— 有值即「这张在 QQ 收藏里也有一份」，改名/删除要对两边都生效；
- `qqMd5` —— 从 emoji_id 拆出来的 md5，用来认「id 变了但还是同一张图」。

匹配顺序（`planStickerSync`）：

1. `qqEmojiId` 相等 → 同一张，**什么都不做**（这是稳态，不该每次同步都报一堆动作）；
2. `qqMd5` 相等但 id 不同 → 只回填 id（`rebind`），**不重新导入**；
3. 都没有 → 本地有就推上去（`push`），QQ 有就导下来（`importFaces`）。

第 2 条是关键：同一张图在 QQ 里删掉再加，`emoji_id` 会换、`md5` 不变。只按 id 对账的话，
这会被算成「QQ 新增一张 + 本地那张失效」，结果就是本地多一份重复的图，而原来打好的标签进了回收站。

## 4. 六个方向

一次同步按顺序做这些事：

| 方向 | 触发条件 | 动作 |
| --- | --- | --- |
| 导入 | QQ 有、本地没有 | 下载 → 缩到 200px → 存文件 → 建行（`source: "qq"`） |
| 认领 | 导入时发现本地已有同一张图（`contentHash` 相同） | 把 QQ 的 id 绑到已有的行上，不重复存图 |
| 改绑 | id 对不上但 md5 对得上 | 只回填 id |
| 推送 | 本地有、QQ 没有、并且是启用状态 | `add_custom_face` → 回填 id → 写备注 |
| 回收 | 本地有 `qqEmojiId`、QQ 里查不到、内容指纹也对不上 | 进回收站（`deletedReason: "qq"`） |
| 补删 | 本地删过（`deletedReason: "local"`）、QQ 还留着 | 再删一次 QQ |

外加一条「改备注」：名字和 QQ `desc` 不一致的，把本地的名字写过去。本地为准。

## 5. 删除的方向不能混

回收站里的行分两种来源（`deletedReason`），处理方式相反：

- `local`（用户在本地点的删除）：意图是「两边都不要」。QQ 还在就**补删**；
- `qq`（QQ 那边先没的）：只是本地跟着收起来。如果它**又在 QQ 里出现了**——说明用户自己加回去了——
  就**恢复原来那一行**，标签还在。

分不清这两种，就会出现「用户刚在 QQ 里把表情加回来，同步一下又被删了」。

## 6. 回收站

删除一律软删（`deletedAt` + `deletedReason`），图留在磁盘上。

为什么：QQ 那边一删、本地连标签一起硬删，用户下次再收藏回来得重新打一遍标。
回收站保留 30 天，期间能恢复；`purge` 才是真删（行 + 文件）。

过期清理由**打开回收站时顺手做**（`purgeTrashedStickers`），不挂定时任务——
回收站是低频页面，为删几张图常驻一个调度器不划算，没人打开时那些文件也不碍事。

## 7. 安全阀：拉不到列表 ≠ 全被删了

`fetch_custom_face_detail` 回空数组有两种可能，在接口层面长得一模一样：

- 收藏真的被清空了；
- 网关没登录 / 接口抽风 / 换了个不支持的网关。

所以：**QQ 回 0 条，而本地有一堆挂着 `qqEmojiId` 的** → 这次什么都不做（不删、不导、不推），
返回 `ok: false` + 一条 `warnings` 说明原因。

误判成前者会把几十张图连同标签一起扫进回收站；误判成后者最多是这次没同步上。这个不对称决定了取舍。

## 8. 几条刻意的取舍

- **导入不调模型**。一次可能导几十张，逐张打标等于一次同步烧掉几十次视觉请求。
  导入只拿 QQ 备注当名字（空的就是「未命名表情 N」，同名补序号），打标交给页面上用户点一次的
  「逐张识别补上」（复用已有的 `relabel`，逐张串行、失败不中断）。
- **名字以本地为准**。PATCH 改名会回写 QQ 备注；回写失败**不阻断**本地改名（本地是主操作），
  结果放在响应的 `qqDesc` 里，下次同步会再补一次。批量重新识别后的漂移也靠这一步追平。
- **上传一张就顺手推进 QQ**。用户要的是「两边同一批」，加一张还要再点一次同步才知道能推上去太绕。
  推失败本地已经加好了，不重做。
- **限量 + 报出剩余**。`MAX_IMPORT_PER_RUN = 60`、`MAX_PUSH_PER_RUN = 30`、`MAX_NAME_SYNC_PER_RUN = 20`。
  超出的写进 `warnings`，否则用户以为搬完了。
- **手动触发，不做定时**。一次可能搬几十张（下载 + 缩图 + 上传），后台悄悄跑完只会让人以为表情库自己变了。
- **多绑定时只同步第一个 QQ 号**。收藏夹是「号」级别的，取绑定顺序第一个并在页面说明。

## 9. 发送侧：优先发收藏里那张

同步做完之后，她在 QQ 里发的是**收藏夹里的那张**，不是重新上传一张图。

`send_custom_face`（SnowLuma 扩展 action，`sendOnebotCustomFace`）实测结果：

```
send_custom_face { group_id | user_id, emoji_id }
→ retcode 0
→ get_msg: [{ type: "image", data: {
     url: "https://p.qpic.cn/qq_expression/.../<emoji_id>/0",
     sub_type: 1, summary: "[动画表情]" } }]
```

`sub_type: 1` + `[动画表情]` + `qq_expression` 路径 = 走的是原生表情通道，
不是一张聊天图片（普通图片段是 `sub_type: 0` + `[图片]`）。在 QQ 里长按是「添加到表情」而不是「保存图片」。

三条路从「最像她本人」到「一定发得出去」：

| 顺序 | 用什么 | 条件 | 失败时 |
| --- | --- | --- | --- |
| 1 | `send_custom_face`（收藏表情） | 行上有 `qqEmojiId` | 记日志，退到 2 |
| 2 | `image` 段（本地文件 base64） | 总有 | 记日志，这条不发 |
| 3 | `face` 段（QQ 内置表情） | 没有表情包时 | — |

第 1 条失败最常见的原因是「收藏里那张被删了、本地还没同步」——此时报错是
`custom face is not in the saved sticker list`，退到图片段正好补上这个缺口。

**两个坑**：

- `emoji_id` 要**完整**的 `<QQ号>_0_0_0_<md5>_0_0`；同名的 `mface` 段要的是裸 32 位 md5、
  字段名还是驼峰 `emojiId`，两者别混（`mface` 用完整 id 会报
  `field "emojiId" must be exactly 32 hexadecimal characters`，用裸 md5 又报
  `missing required or usable fields`——那条路没走通，最终用的是 action）。
- `qqEmojiId` 必须从 `STICKER_CATALOG_SELECT` 一路带到 `sticker` 选项：
  丢在任何一环都不会报错，只会静默退回图片段。`test-stickers` 对这一步有断言。

群聊：`send_custom_face` 接受 `group_id`（用不存在的群号试过，QQ 回的是协议层
`OIDB error ... verify identify fail`，说明参数被接受、只是群不存在），但**还没有在真群里发过**。

## 10. 验证

```bash
yarn test:qq-sticker-sync      # 纯函数：md5 解析、列表解析、对账各分支（不连库不连网）
yarn test:qq-sticker-sync-db   # 落库端到端（自建临时角色 + 注入假 QQ，跑完删掉）
yarn test:stickers             # 清单做减法 + qqEmojiId 是否被带到发送侧
yarn probe:custom-face         # 只读：登录信息 + 收藏列表形状
yarn probe:custom-face --flow  # 真加一张 → 改备注 → 回查 → 删掉（会写账号，账号恢复原样）
yarn probe:custom-face-send    # 真发一条收藏表情，用 get_msg 回读确认是表情段
```

真机上的完整链路（真下载、真上传、真发一条）没有自动化测试：它需要一个小号、会改账号数据，
不适合放进 `verify:local`。接口形状由探针保证，对账逻辑由纯函数测试保证。
