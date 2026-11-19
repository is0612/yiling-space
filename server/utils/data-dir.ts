import path from "node:path";

/**
 * 运行时数据根目录（`credentials-encryption.key`、表情包、语音临时文件等）。
 *
 * 默认仍是 `<当前工作目录>/.data`，和旧行为完全一致；桌面端/自定义部署通过
 * `YILING_DATA_DIR` 指到可写目录（例如程序旁的 `data` 或 `%APPDATA%`）。
 *
 * 只在这里拼一次路径，别在业务代码里再写 `path.join(process.cwd(), ".data", ...)` ——
 * 桌面端从开始菜单启动时 cwd 不可控，散落的写法会各自读到不同目录。
 */
export function dataDir(): string {
  const configured = process.env.YILING_DATA_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(process.cwd(), ".data");
}

/** 数据目录下的一个路径。 */
export function dataPath(...segments: string[]): string {
  return path.join(dataDir(), ...segments);
}
