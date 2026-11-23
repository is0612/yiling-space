import assert from "node:assert/strict";
import { composePublishedVisualPrompt } from "../server/utils/visual-profile-prompt";

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

const prompt = composePublishedVisualPrompt(snapshot, "芦苇荡边回眸，暖色夕阳，半身构图");
assert(prompt.includes("蓝紫色长发"));
assert(prompt.includes("自然手绘风格"));
assert(prompt.includes("深蓝女仆装"));
assert(prompt.includes("避免：成熟女性体型"));
assert(prompt.includes("芦苇荡边回眸"));
assert(!prompt.includes("浅色针织外套"));
assert(!prompt.includes("红色礼服"));

const noProfile = composePublishedVisualPrompt({}, "一只鲸鱼跃出海面");
assert.equal(noProfile, "一只鲸鱼跃出海面");

const longIdentity = composePublishedVisualPrompt({ corePrompt: "身份".repeat(2000) }, "当前场景描述");
assert(longIdentity.length <= 1200);
assert(longIdentity.endsWith("当前场景描述"));

console.log("visual-profile-prompt: ok");
