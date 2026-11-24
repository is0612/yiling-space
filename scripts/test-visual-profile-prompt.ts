import assert from "node:assert/strict";
import { limitReferenceNotes, withoutReferenceNotes } from "../server/utils/image-generation";
import { canAttachReferences, composeReferenceSection, composePublishedVisualPrompt } from "../server/utils/visual-profile-prompt";
import { isVisualAssetPathSafe, readVisualProfileReferences, selectSnapshotReferenceAssets } from "../server/utils/visual-profile-references";

const snapshot = {
  coreAppearance: "蓝紫色长发、蓝色眼睛、鲸鱼耳与尾巴",
  corePrompt: "少女形态，中间体型比例；自然手绘风格",
  negativePrompt: "成熟女性体型、过度磨皮、过度梦幻",
  outfits: [
    { name: "日常服", prompt: "浅色针织外套", isDefault: false },
    { name: "深蓝女仆装", prompt: "深蓝女仆装，白色围裙", isDefault: true },
    { name: "错误混入", prompt: "红色礼服", isDefault: false },
  ],
};

// 1. 四段齐全时，顺序固定为 人物 → 造型 → 画面 → 避免
const prompt = composePublishedVisualPrompt(snapshot, "芦苇荡边回眸，暖色夕阳，半身构图");
assert(prompt.includes("【人物】蓝紫色长发"));
assert(prompt.includes("自然手绘风格"));
assert(prompt.includes("【造型·深蓝女仆装】深蓝女仆装，白色围裙"));
assert(prompt.includes("【画面】芦苇荡边回眸"));
assert(prompt.includes("【避免】成熟女性体型"));
assert(
  prompt.indexOf("【人物】") < prompt.indexOf("【造型·") &&
  prompt.indexOf("【造型·") < prompt.indexOf("【画面】") &&
  prompt.indexOf("【画面】") < prompt.indexOf("【避免】"),
  "sections must keep 人物 → 造型 → 画面 → 避免 order",
);

// 2. 只拼默认造型，不把其它造型混进来
assert(!prompt.includes("浅色针织外套"));
assert(!prompt.includes("错误混入"));

// 3. 画面里写了服装：以画面为准，默认造型整段不出现
const explicitOutfit = composePublishedVisualPrompt(snapshot, "她换上红色礼服，在海边回眸");
assert(explicitOutfit.includes("红色礼服"));
assert(!explicitOutfit.includes("深蓝女仆装"), "explicit outfit requests must override the default outfit");
assert(!explicitOutfit.includes("【造型"), "no outfit section when the scene already names one");

// 4. 款式名词（没有动词）也算显式指定，退回不拼默认造型是安全的一侧
const nounOnlyOutfit = composePublishedVisualPrompt(snapshot, "她站在窗前，一条百褶裙");
assert(!nounOnlyOutfit.includes("深蓝女仆装"));

// 5. 没有档案：原样交出场景，不加任何标签
const noProfile = composePublishedVisualPrompt({}, "一只鲸鱼跃出海面");
assert.equal(noProfile, "一只鲸鱼跃出海面");

// 6. 只有档案、没有场景：仍用同一套分段
const noScene = composePublishedVisualPrompt(snapshot, "   ");
assert(noScene.startsWith("【人物】"));
assert(noScene.includes("【造型·深蓝女仆装】"));
assert(!noScene.includes("【画面】"));

// 7. 超长身份：画面完整保留，身份被截断
const longIdentity = composePublishedVisualPrompt({ corePrompt: "身份".repeat(2000) }, "当前场景描述");
assert(longIdentity.length <= 1200);
assert(longIdentity.endsWith("当前场景描述"), "scene must survive intact and stay last");
assert(longIdentity.startsWith("【人物】"));

// 8. 场景自己就超预算：退回纯场景，不塞半截身份
const hugeScene = "画".repeat(1500);
const onlyScene = composePublishedVisualPrompt(snapshot, hugeScene);
assert.equal(onlyScene.length, 1200);
assert(!onlyScene.includes("【人物】"));

// 9. 带参考图：说明段就位，且排在造型之后、画面之前
const withRefs = composePublishedVisualPrompt(snapshot, "窝在床上玩手机，午后暖阳", {
  referenceLabels: ["标准形象", "正面视图"],
});
assert(withRefs.includes("【参考图】图1 标准形象、图2 正面视图"));
assert(withRefs.includes("只用来确定长相"));
assert(withRefs.includes("固定外貌以【人物】和参考图为准"));
assert(withRefs.includes("不得改写发长发色、瞳色、耳尾或体型"));
assert(withRefs.includes("服装、姿势、表情、视角和背景都不要照搬"));
assert(
  withRefs.indexOf("【造型·") < withRefs.indexOf("【参考图】") &&
  withRefs.indexOf("【参考图】") < withRefs.indexOf("【画面】"),
  "参考图说明要夹在造型与画面之间",
);
assert(withRefs.length <= 1200);

// 10. 不带参考图时不该凭空出现这一段
assert(!prompt.includes("【参考图】"));
assert.equal(composeReferenceSection([]), "");

// 11. 画面太长时判定为「放不下」，调用方据此不传图
assert(canAttachReferences("窝在床上玩手机", ["标准形象"]));
assert(!canAttachReferences("画".repeat(1100), ["标准形象", "正面视图", "侧面视图"]));

// 12. 素材路径只认当前角色的档案目录
assert(isVisualAssetPathSafe("char-1", "visual-profile/char-1/abc.jpg"));
assert(!isVisualAssetPathSafe("char-1", "visual-profile/char-2/abc.jpg"));
assert(!isVisualAssetPathSafe("char-1", "visual-profile/char-1/../char-2/abc.jpg"));
assert(!isVisualAssetPathSafe("char-1", "images/char-1/abc.jpg"));
assert(!isVisualAssetPathSafe("", "visual-profile//abc.jpg"));

// 13. edits 回退时去掉【参考图】段：图都没发，不能留「图1」这种空指代
const stripped = withoutReferenceNotes(withRefs);
assert(!stripped.includes("【参考图】"));
assert(!stripped.includes("图1 "));
assert(stripped.includes("【人物】"));
assert(stripped.includes("【画面】"));
assert(stripped.length < withRefs.length);
// 本来就没有这一段时原样返回
assert.equal(withoutReferenceNotes("【画面】一只鲸鱼跃出海面"), "【画面】一只鲸鱼跃出海面");

// 14. 只吃一张图的形状：说明段也收成一张，别让模型惦记没给它的图
const limited = limitReferenceNotes(withRefs, 1);
assert(limited.includes("【参考图】图1 标准形象——"));
assert(!limited.includes("图2"));
assert(limited.includes("【画面】"));
assert(limited.includes("【避免】"));
// 只有一张时不动它
assert.equal(limitReferenceNotes(limited, 4), limited);

// 15. 截断要落在分隔符上：不能切出 `tag1` 这种半个 tag
const manyTags = Array.from({ length: 300 }, (_, index) => `tag${index}`).join(", ");
const truncated = composePublishedVisualPrompt({ corePrompt: manyTags }, "短场景");
const personPart = truncated.slice(truncated.indexOf("【人物】") + 4, truncated.indexOf("；【画面】"));
const pieces = personPart.split(",").map(piece => piece.trim()).filter(Boolean);
assert(pieces.length > 0);
assert(pieces.every(piece => /^tag\d+$/u.test(piece)), "截断不能切出半个 tag");
assert(truncated.length <= 1200);


// 16. 正式快照的参考图选择：每种用途先取最新一张，不让大量标准图挤掉三视图。
const snapshotAssets = [
  ...Array.from({ length: 8 }, (_, index) => ({
    id: "standard-" + index, kind: "STANDARD", label: "标准图 " + index,
    relativePath: "visual-profile/char-1/standard-" + index + ".jpg", sortOrder: index,
    createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  })),
  ...["FRONT_VIEW", "SIDE_VIEW", "BACK_VIEW"].map((kind, index) => ({
    id: kind, kind, label: kind,
    relativePath: "visual-profile/char-1/" + kind + ".jpg", sortOrder: 0,
    createdAt: new Date(Date.UTC(2026, 0, 20 + index)).toISOString(),
  })),
];
const selectedSnapshotAssets = selectSnapshotReferenceAssets(snapshotAssets);
assert.deepEqual(selectedSnapshotAssets.map(asset => asset.kind), [
  "STANDARD", "FRONT_VIEW", "SIDE_VIEW", "BACK_VIEW",
]);
assert.equal(selectedSnapshotAssets[0]!.id, "standard-7", "同用途优先最新上传的素材");
assert.deepEqual(selectSnapshotReferenceAssets(undefined), [], "旧快照没有 assets 时不能偷读实时素材库");
assert.deepEqual(selectSnapshotReferenceAssets([{ id: "bad", kind: "EXPRESSION", label: "表情", relativePath: "x", sortOrder: 0 }]), []);
assert.equal(selectSnapshotReferenceAssets(snapshotAssets).length, 4, "参考图总数不能超过 4 张");

// 17. 生图查询只能按正式快照的 ID 取素材；旧快照缺少 assets 时不查询实时素材库。
{
  const queries: unknown[] = [];
  const mockPrisma = {
    characterVisualAsset: {
      findMany: async (args: unknown) => {
        queries.push(args);
        return [];
      },
    },
  } as never;
  await readVisualProfileReferences(mockPrisma, "char-1", snapshotAssets);
  const query = queries[0] as { where: { id: { in: string[] }; profile: { characterId: string } } };
  assert.deepEqual(query.where.id.in, selectedSnapshotAssets.map(asset => asset.id));
  assert.equal(query.where.profile.characterId, "char-1");
  queries.length = 0;
  await readVisualProfileReferences(mockPrisma, "char-1", undefined);
  assert.equal(queries.length, 0, "旧快照不能退回查询角色当前素材");
}

console.log("visual-profile-prompt: ok");
