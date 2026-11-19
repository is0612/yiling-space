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

const resolved = module.resolveLocalPath("src");
assert.equal(resolved.relative, "src");
assert.equal(resolved.absolute, path.join(root, "src"));
expectError(() => module.resolveLocalPath("../outside"), 403);
expectError(() => module.resolveLocalPath("C:\\Windows"), 400);
expectError(() => module.resolveLocalPath("/etc"), 400);

const listing = module.listLocalDirectory("");
const names = listing.entries.map((entry: { name: string }) => entry.name);
assert.ok(names.includes("src"));
assert.ok(names.includes("README.md"));
assert.ok(!names.includes("node_modules"));
assert.ok(!names.includes(".env"));

const read = module.readLocalTextFile("src/a.ts");
assert.match(read.content, /needle/);
expectError(() => module.readLocalTextFile(".env"), 403);
expectError(() => module.readLocalTextFile("binary.bin"), 415);
expectError(() => module.readLocalTextFile("large.txt"), 413);

const search = module.searchLocalProject("needle", "");
assert.ok(search.matches.some((match: { path: string; kind: string }) =>
  match.path === "src/a.ts" && match.kind === "content"));
expectError(() => module.searchLocalProject("a", ""), 400);

fs.rmSync(root, { recursive: true, force: true });
console.log("Local observe tests passed: path traversal, ignore/sensitive filters, text/binary/size limits, search.");
