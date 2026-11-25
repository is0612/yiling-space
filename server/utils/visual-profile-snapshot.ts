/**
 * 形象档案版本快照里的素材引用。
 *
 * 只记 id / 用途 / 名称 / 相对路径，**不记字节**：素材文件删掉之后，
 * 快照里留一份 base64 也还原不回来，反而把 version 表撑大。
 * 这样记录能回答的是「这一版当时引用了哪几张图」，不是「这一版长什么样」。
 */
export type SnapshotAsset = {
  id: string;
  kind: string;
  label: string;
  relativePath: string;
  sortOrder: number;
  /** 上传时间用于同一用途的素材替换：最新上传者优先。旧快照可缺省。 */
  createdAt?: string;
};

/** 写快照和查快照必须用同一套字段，否则两边形状会漂。 */
export const snapshotAssetSelect = {
  id: true,
  kind: true,
  label: true,
  relativePath: true,
  sortOrder: true,
  createdAt: true,
} as const;

export function toSnapshotAssets(
  rows: ReadonlyArray<{ id: string; kind: string; label: string; relativePath: string; sortOrder: number; createdAt: Date }>,
): SnapshotAsset[] {
  return rows.map(row => ({
    id: row.id,
    kind: row.kind,
    label: row.label.slice(0, 120),
    relativePath: row.relativePath.slice(0, 500),
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * 版本快照里的 LoRA 配置。
 *
 * LoRA 写进**快照**而不是只放在 profile 上，是为了让「发布」这件事有意义：
 * 发布 v2 时用的是哪个 LoRA、多强、触发词是什么，都该跟着那一版定下来。
 * 只读 profile 的话，改一次强度会让所有历史版本一起变 —— 那就不叫版本了。
 *
 * 返回 null = 这一版没用 LoRA（老快照没有这三个键，也走这条路）。
 */
export type SnapshotLora = { name: string; strength: number; trigger: string };

/**
 * LoRA 名要**保留相对路径**（例如 `moss/鲸鱼娘-DeepSeek Whalegirl/xxx.safetensors`）。
 *
 * 这里曾经用 `split(/[/\\]/u).pop()` 只留末段文件名。引擎里的 LoRA 是按目录组织的 ——
 * 没有子目录时截断恰好等于原名，一旦角色 LoRA 放在 `loras/moss/<角色>/` 下面就出事：
 * ComfyUI 回 `value not in list`，而报错信息里完全看不出是路径被截掉了。
 *
 * 绝对路径和 `..` 仍然挡掉：它们既不是引擎认的名字，也不该出现在工作流里。
 * 老快照可能把绝对路径存了进来，那种就退回原来的「取末段」行为 —— 至少还能对上
 * 根目录下放着的 LoRA。
 */
function sanitizeLoraName(rawName: string): string {
  const trimmed = rawName.trim();
  if (!trimmed || trimmed.includes("..")) return "";
  // Windows 盘符路径、UNC、POSIX 绝对路径
  if (/^[a-zA-Z]:[/\\]/u.test(trimmed) || /^[/\\]/u.test(trimmed)) {
    return trimmed.split(/[/\\]/u).pop() ?? "";
  }
  return trimmed;
}

export function readSnapshotLora(snapshot: unknown): SnapshotLora | null {
  const raw = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown>
    : {};
  const rawName = typeof raw.loraName === "string" ? raw.loraName.trim() : "";
  const name = sanitizeLoraName(rawName);
  if (!name) return null;
  const strength = typeof raw.loraStrength === "number" && Number.isFinite(raw.loraStrength)
    ? Math.min(2, Math.max(0, raw.loraStrength))
    : 1;
  const trigger = typeof raw.loraTrigger === "string" ? raw.loraTrigger.trim().slice(0, 200) : "";
  return { name, strength, trigger };
}
