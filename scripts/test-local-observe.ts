import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yiling-local-observe-"));
process.env.YILING_LOCAL_ROOT = root;

fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "a.ts"), "export const needle = 1;\n");
fs.writeFileSync(path.join(root, "README.md"), "# local observe\n");
fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n");
fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "secret\n");
fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
fs.writeFileSync(path.join(root, "large.txt"), "x".repeat(300 * 1024));

const module = await import("../server/utils/local-observe");

function expectError(fn: () => unknown, code: number) {
  try {
    fn();
  } catch (error) {
    assert.equal(error instanceof module.LocalObserveError, true);
    assert.equal(error.statusCode, code);
    return;
  }
  assert.fail(`expected LocalObserveError ${code}`);
}

const resolved = module.resolveLocalPath(root, "src");
assert.equal(resolved.relative, "src");
assert.equal(resolved.absolute, path.join(root, "src"));
expectError(() => module.resolveLocalPath(root, "../outside"), 403);
expectError(() => module.resolveLocalPath(root, "C:\\Windows"), 400);
expectError(() => module.resolveLocalPath(root, "/etc"), 400);

const listing = module.listLocalDirectory(root, "");
const names = listing.entries.map((entry: { name: string }) => entry.name);
assert.ok(names.includes("src"));
assert.ok(names.includes("README.md"));
assert.ok(!names.includes("node_modules"));
assert.ok(!names.includes(".env"));

const read = module.readLocalTextFile(root, "src/a.ts");
assert.match(read.content, /needle/);
expectError(() => module.readLocalTextFile(root, ".env"), 403);
expectError(() => module.readLocalTextFile(root, "binary.bin"), 415);
expectError(() => module.readLocalTextFile(root, "large.txt"), 413);

const search = module.searchLocalProject(root, "needle", "");
assert.ok(search.matches.some((match: { path: string; kind: string }) =>
  match.path === "src/a.ts" && match.kind === "content"));
expectError(() => module.searchLocalProject(root, "a", ""), 400);

const validated = module.validateLocalRootPath(root);
assert.equal(validated, fs.realpathSync(root));
expectError(() => module.validateLocalRootPath("relative/path"), 400);
if (process.platform === "win32") {
  expectError(() => module.validateLocalRootPath("C:\\Windows"), 403);
  expectError(() => module.validateLocalRootPath("C:\\"), 400);
}

fs.rmSync(root, { recursive: true, force: true });
console.log("Local observe tests passed: path traversal, root validation, ignore/sensitive filters, text/binary/size limits, search.");
