export const galaxySize = { width: 840, height: 640 } as const;

// The core represents the existing interaction layer, not a new service or a fixed character.
export const galaxyNodes = {
  core: { name: "互动核心", planet: "互动核心", orbit: "互动入口", x: 418, y: 285, size: 122, color: "#8be4ff", path: "/chat", description: "网页和渠道的对话在这里接收并回复。回复可按当前问题、场景与可读范围装配记忆、知识和成长资料。" },
  memory: { name: "记忆系统", planet: "记忆星球", orbit: "经历与记忆", x: 205, y: 132, size: 54, color: "#6ec8ff", path: "/growth/memory", description: "整理忆泡、阶段总结和长期记忆，保留经历和结论的来源。" },
  events: { name: "成长事件中心", planet: "事件星站", orbit: "通知与投递", x: 436, y: 68, size: 32, color: "#9aaaff", path: "/growth/deliveries", description: "接收已登记的领域事件，按订阅可靠投递。事件携带来源引用，具体内容仍由各领域提供。" },
  knowledge: { name: "知识系统", planet: "知识星球", orbit: "从证据到知识", x: 635, y: 118, size: 46, color: "#77e7e2", path: "/growth/knowledge", description: "整理知识候选、正式知识和来源。符合条件的知识可以被对话和反思读取。" },
  social: { name: "社交系统", planet: "关系星球", orbit: "相处与变化", x: 81, y: 296, size: 47, color: "#f5a3d2", path: "/growth/social", description: "记录社交经历、好友关系及关系评估。符合条件的社交经历可引用原始忆泡。" },
  reflection: { name: "反思系统", planet: "反思星球", orbit: "回顾与审核", x: 748, y: 283, size: 61, color: "#bc9bff", path: "/growth/reflection", description: "从证据中提出观察、推断和建议，保留人工审阅结果。已采纳的反思可被其他领域选作来源。" },
  experience: { name: "互动经验", planet: "经验星球", orbit: "反馈与修正", x: 133, y: 479, size: 56, color: "#ffd0a3", path: "/growth/memory/interaction-experiences", description: "依据明确的用户反馈记录理解、指代、场景或表达方面的经验，保留适用会话与证据。" },
  goals: { name: "目标与愿望", planet: "目标星球", orbit: "方向与进展", x: 293, y: 391, size: 34, color: "#a6dcac", path: "/growth/goals", description: "保存角色的目标、愿望和进展。添加目标或进展时可主动选择已有记录作为依据。" },
  preferences: { name: "偏好系统", planet: "偏好星球", orbit: "长期倾向", x: 570, y: 375, size: 38, color: "#e8a7ff", path: "/growth/preferences", description: "记录喜欢、厌恶和感兴趣的主题。有效偏好可以按对话主题被检索。" },
  language: { name: "表达习惯", planet: "表达星球", orbit: "语言与场景", x: 676, y: 498, size: 47, color: "#94afff", path: "/growth/language", description: "保存语气、措辞和长短等表达习惯，按场景和范围为后续回复提供参考。" },
  self: { name: "自我认知", planet: "认知星球", orbit: "理解自身变化", x: 396, y: 532, size: 60, color: "#adbbff", path: "/growth/self-understanding", description: "整合当前有权读取的领域证据，帮助角色回顾自身经历与变化，并保留来源的范围与不确定性。" },
} as const;

export type GalaxyNodeId = keyof typeof galaxyNodes;
export const galaxyNodeIds = Object.keys(galaxyNodes) as GalaxyNodeId[];

export const galaxyKinds = {
  read: { label: "资料读取", color: "#8fc8ff", dash: undefined },
  write: { label: "证据沉淀", color: "#f1bae9", dash: "8 5" },
  event: { label: "事件投递", color: "#75ead9", dash: "2 6" },
  integrate: { label: "认知整合", color: "#c0adff", dash: "10 4 2 4" },
} as const;

export type GalaxyKind = keyof typeof galaxyKinds;
export type GalaxyEdge = { from: GalaxyNodeId; to: GalaxyNodeId; kind: GalaxyKind; description: string; bend?: number };

// Arrows follow information from source to consumer, including when the consumer initiates a read.
export const galaxyEdges: readonly GalaxyEdge[] = [
  // memory-change-apply, social-experiences, growth-event-center and growth-event-consumers
  { from: "core", to: "memory", kind: "write", bend: 39, description: "记忆任务依据保存的原始消息和事件，提取忆泡或生成阶段总结。" },
  { from: "memory", to: "core", kind: "read", bend: 32, description: "对话按当前身份、可读范围和问题召回记忆资料。" },
  { from: "memory", to: "social", kind: "write", bend: 15, description: "符合条件的忆泡会关联到对应对象的社交经历，保留忆泡引用。" },
  { from: "memory", to: "events", kind: "event", bend: -13, description: "发布新忆泡的来源校验事件；用户从公开忆泡发起知识候选请求时，也会发布相应事件。" },
  { from: "social", to: "events", kind: "event", bend: -54, description: "新建社交经历时，发布包含经历引用的事件。" },
  { from: "events", to: "social", kind: "event", bend: 31, description: "社交经历事件由现有消费者处理，可按条件派发关系评估任务。" },
  { from: "events", to: "knowledge", kind: "event", bend: -20, description: "知识消费者按公开忆泡候选请求建立待处理的候选，由用户后续审阅。" },
  // experience-reflection, reflection-worker and preferences-sources
  { from: "core", to: "experience", kind: "write", bend: 30, description: "助手回复和用户的明确反馈可以作为一条互动经验的证据。" },
  { from: "experience", to: "core", kind: "read", bend: 26, description: "有效且与当前场景匹配的互动经验可用于后续回复。" },
  { from: "experience", to: "reflection", kind: "read", bend: 120, description: "会话反思在符合条件时读取同一会话中的多条有效互动经验。" },
  { from: "memory", to: "reflection", kind: "read", bend: -55, description: "阶段反思可读取角色公开范围的有效忆泡和当前阶段总结。" },
  { from: "knowledge", to: "reflection", kind: "read", bend: -15, description: "阶段反思可读取手动添加或导入的有效知识作为参考。" },
  { from: "reflection", to: "language", kind: "write", bend: -18, description: "重复且一致的会话表达反馈可在反思时形成待审表达候选，生效需单独确认。" },
  { from: "reflection", to: "preferences", kind: "read", bend: -14, description: "建立偏好时可人工选用已采纳的公开反思作为来源。" },
  { from: "reflection", to: "goals", kind: "read", bend: 5, description: "填写目标或进展时可人工选用已采纳的公开反思作为来源。" },
  // chat.post / channel-adapter pipeline: eligible records are assembled on demand.
  { from: "knowledge", to: "core", kind: "read", bend: 30, description: "对话可以检索与问题相关的正式知识。" },
  { from: "social", to: "core", kind: "read", bend: -20, description: "网页对话可以读取角色的熟人名册，作为回答关系问题的参考。" },
  { from: "language", to: "core", kind: "read", bend: 24, description: "有效且符合当前会话或场景的表达习惯可参与回复。" },
  { from: "goals", to: "core", kind: "read", description: "与当前问题相关的有效目标可参与对话上下文。" },
  { from: "preferences", to: "core", kind: "read", description: "对话可以引用与当前话题相关的有效偏好。" },
  // self-understanding-reader: these are evidence inputs, not writes to a profile.
  { from: "memory", to: "self", kind: "integrate", bend: 45, description: "自我认知可结合有权读取的有效忆泡与长期记忆。" },
  { from: "social", to: "self", kind: "integrate", bend: 45, description: "在具备权限的场景中，角色可回顾已确认的关系记录。" },
  { from: "experience", to: "self", kind: "integrate", bend: 14, description: "自我认知的对话上下文可引用当前会话的有效互动经验，保留适用范围。" },
  { from: "reflection", to: "self", kind: "integrate", bend: -30, description: "自我认知可参考已采纳且证据仍有效的反思，保留推断的不确定性。" },
  { from: "language", to: "self", kind: "integrate", bend: -20, description: "自我认知可参考当前有效、场景适用的表达习惯。" },
  { from: "preferences", to: "self", kind: "integrate", description: "自我认知可参考当前有效的偏好。" },
  { from: "goals", to: "self", kind: "integrate", description: "自我认知可参考当前仍有效的目标与愿望。" },
  { from: "knowledge", to: "self", kind: "integrate", bend: -126, description: "有效知识提供学习内容的证据，帮助回顾学过什么。" },
  { from: "self", to: "core", kind: "read", bend: 20, description: "当问题涉及自身身份、经历或变化时，对话按场景读取自我认知证据。" },
];

export const galaxyGrowthRoles: Record<GalaxyNodeId, string> = {
  core: "把可用的成长资料带回对话，也为后续学习留下新的互动证据。",
  memory: "让经历可以被找回、复核，也能成为社交、知识或反思的来源。",
  events: "把领域变化通知给已订阅的处理方，让协作不必发生在同一次请求里。",
  knowledge: "把合适的资料整理成可检索的知识，为回答和回顾提供参考。",
  social: "把相处经历与关系记录关联起来，让关系变化有依据可查。",
  reflection: "把多条证据归纳为可审核的观察、解释与建议，保留不确定性。",
  experience: "把明确反馈留成有适用场景的经验，让后续回复和反思可以参考。",
  goals: "保留角色在意的方向与进展，让它们在相关对话和自我回顾中有据可查。",
  preferences: "把审慎确认的倾向留下，让后续对话可以持续参考。",
  language: "把适用场景里反复出现的表达反馈整理为可启用、可复核的习惯。",
  self: "在被问到自身经历或变化时，把有权限的线索结合起来，帮助角色有依据地理解自己。",
};

export const galaxyEdgeKey = (from: GalaxyNodeId, to: GalaxyNodeId) => `${from}-${to}`;

export function galaxyEdgePath({ from, to, bend = 0 }: GalaxyEdge) {
  const a = galaxyNodes[from];
  const b = galaxyNodes[to];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  const mx = (a.x + b.x) / 2 - dy / length * bend;
  const my = (a.y + b.y) / 2 + dx / length * bend;
  const endpoint = (node: typeof a, gap: number) => {
    const distance = Math.hypot(mx - node.x, my - node.y);
    const radius = node.size / 2 + gap;
    return `${node.x + (mx - node.x) * radius / distance},${node.y + (my - node.y) * radius / distance}`;
  };
  return `M${endpoint(a, 5)} Q${mx},${my} ${endpoint(b, 12)}`;
}
