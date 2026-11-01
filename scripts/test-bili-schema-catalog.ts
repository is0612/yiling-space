import assert from "node:assert/strict";
import { mapSchemaToGroups } from "../server/utils/channel-adapter/bili/schema-catalog";

const mapped = mapSchemaToGroups({
  version: "0.6.0",
  commands: [
    {
      command: "bili video watch",
      help: "看懂视频（含字幕 / 抽帧）",
      params: [
        { name: "video_id", kind: "argument", type: "str", required: true, default: null, help: "BV 号 / 链接" },
        { name: "frames", kind: "option", flags: ["--frames"], type: "int", required: false, default: 9, help: "抽帧张数" },
      ],
    },
    {
      command: "bili comment post",
      help: "发评论",
      params: [
        { name: "target", kind: "argument", type: "str", required: true, help: "BV 号 / 链接" },
        { name: "text", kind: "argument", type: "str", required: true, help: "正文" },
      ],
    },
  ],
});

assert(mapped, "schema with commands must map to a catalog.");
assert.equal(mapped.version, "0.6.0");
assert.equal(mapped.groups[0]?.group, "刷B站", "面板自己的值班入口必须保留在最前。");

const video = mapped.groups.find((group) => group.group === "视频")?.items.find((item) => item.id === "video.watch");
assert(video, "video watch must be present.");
assert.equal(video.label, "看懂视频");
assert.equal(video.write, false);
assert.equal(video.params?.[0]?.pos, true);
assert.equal(video.params?.[0]?.label, "BV 号 / 链接");
assert.equal(video.params?.[1]?.flag, "--frames");
assert.equal(video.params?.[1]?.type, "int");
assert.equal(video.params?.[1]?.default, "9");

const comment = mapped.groups.find((group) => group.group === "评论")?.items.find((item) => item.id === "comment.post");
assert(comment, "comment post must be present.");
assert.equal(comment.write, true, "comment post must be marked as a write command.");
assert(comment.params?.every((param) => param.pos === true), "both comment args are positional.");

const system = mapped.groups.find((group) => group.group === "系统");
assert(system?.items.some((item) => item.id === "selfcheck"), "local selfcheck item must stay in 系统.");

assert.equal(mapSchemaToGroups({ commands: [] }), null, "empty schema must fall back to the static catalog.");

console.log("B站 schema 命令表映射测试通过：分组、参数、写操作与本地入口保留。");
