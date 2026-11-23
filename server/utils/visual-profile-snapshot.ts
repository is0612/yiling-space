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
};

/** 写快照和查快照必须用同一套字段，否则两边形状会漂。 */
export const snapshotAssetSelect = {
  id: true,
  kind: true,
  label: true,
  relativePath: true,
  sortOrder: true,
} as const;

export function toSnapshotAssets(
  rows: ReadonlyArray<{ id: string; kind: string; label: string; relativePath: string; sortOrder: number }>,
): SnapshotAsset[] {
  return rows.map(row => ({
    id: row.id,
    kind: row.kind,
    label: row.label.slice(0, 120),
    relativePath: row.relativePath.slice(0, 500),
    sortOrder: row.sortOrder,
  }));
}
