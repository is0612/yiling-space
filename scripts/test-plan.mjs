/** Expand declared package test commands; never infer execution from test source text. */
export function buildTestPlan(scripts, isolatedSuites, options = {}) {
  const entries = Object.entries(scripts).filter(([name, command]) =>
    name.startsWith("test:") && !command.includes("scripts/test-all.mjs"));
  const roots = entries.map(([name]) => name).filter(name =>
    (!options.only || options.only.test(name)) && (!options.skip || !options.skip.test(name)) &&
    (!options.db || /-db\b|-isolated\b|^test:isolated$/u.test(name)));
  if (!roots.length) throw new Error("没有匹配的 test 脚本。");
  const expanded = [];
  function expand(name, stack = [], applySkip = true) {
    if (applySkip && options.skip?.test(name)) return;
    if (stack.includes(name)) throw new Error(`测试套件循环引用：${[...stack, name].join(" -> ")}`);
    const command = scripts[name];
    if (typeof command !== "string") throw new Error(`测试入口不存在：${name}`);
    if (command.includes("scripts/test-all.mjs")) throw new Error(`测试套件不能递归调用跑批器：${name}`);
    for (const part of command.split(/\s*&&\s*/u)) {
      const alias = /^yarn(?: run)? (test:[\w:-]+)$/u.exec(part);
      if (alias) { expand(alias[1], [...stack, name], applySkip); continue; }
      const leaf = /^(tsx|node) (scripts\/[\w.-]+\.(?:ts|mjs))$/u.exec(part);
      if (!leaf) throw new Error(`无法明确展开 ${name}：${part}；请先声明支持的执行方式。`);
      if (!applySkip || !options.skip?.test(leaf[2])) expanded.push({ runner: leaf[1], file: leaf[2], name });
    }
  }
  for (const root of roots) expand(root);

  const allLeaves = new Map();
  for (const [name] of entries) {
    const before = expanded.length;
    expand(name, [], false);
    for (const leaf of expanded.splice(before)) {
      const previous = allLeaves.get(leaf.file);
      if (previous && previous.runner !== leaf.runner) throw new Error(`同一测试有不同执行器：${leaf.file}`);
      allLeaves.set(leaf.file, leaf);
    }
  }
  const parentsByChild = new Map();
  for (const [parent, children] of Object.entries(isolatedSuites)) {
    if (!/^test-[\w.-]+\.ts$/u.test(parent) || !Array.isArray(children) || !children.length) throw new Error(`非法隔离套件：${parent}`);
    if (!allLeaves.has(`scripts/${parent}`)) throw new Error(`隔离父入口未接入 package.json：${parent}`);
    if (new Set(children).size !== children.length) throw new Error(`隔离套件重复子测试：${parent}`);
    for (const child of children) {
      if (!/^test-[\w.-]+\.(?:ts|mjs)$/u.test(child) || child === parent || isolatedSuites[child]) throw new Error(`非法隔离子测试：${parent} -> ${child}`);
      const file = `scripts/${child}`;
      parentsByChild.set(file, [...(parentsByChild.get(file) ?? []), `scripts/${parent}`]);
    }
  }
  const selectedFiles = new Set(expanded.map(leaf => leaf.file));
  const tasks = new Map();
  const coveredChildren = new Map();
  for (const leaf of expanded) {
    const parents = parentsByChild.get(leaf.file);
    if (parents) {
      // A filtered request for an isolated child still runs its safe parent, never the child on DATABASE_URL.
      const eligible = parents.filter(parent => !options.skip?.test(parent) && !options.skip?.test(allLeaves.get(parent).name));
      const owners = eligible.filter(parent => selectedFiles.has(parent));
      const chosen = owners.length ? owners : eligible.slice(0, 1);
      if (!chosen.length) continue;
      coveredChildren.set(leaf.file, chosen);
      for (const parent of chosen) if (!tasks.has(parent)) tasks.set(parent, allLeaves.get(parent));
    } else if (!tasks.has(leaf.file)) tasks.set(leaf.file, leaf);
  }
  if (!tasks.size) throw new Error("筛选后没有可执行的测试（隔离子测试的安全父入口也可能被 skip 排除了）。");
  const coverage = new Set(tasks.keys());
  for (const file of tasks.keys()) {
    for (const child of isolatedSuites[file.split("/").pop()] ?? []) coverage.add(`scripts/${child}`);
  }
  return {
    roots,
    tasks: [...tasks.values()].map(task => ({ ...task,
      children: (isolatedSuites[task.file.split("/").pop()] ?? []).map(child => `scripts/${child}`),
    })),
    coveredChildren: Object.fromEntries(coveredChildren),
    coverage: [...coverage].sort(),
    expandedCount: expanded.length,
  };
}
