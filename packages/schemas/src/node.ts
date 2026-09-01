import { z } from "zod";

const DISPLAY_ONLY_PROXY_KEYS = new Set(["name", "ps", "remarks", "remark", "display_name"]);

/** Stable connection identity shared by subscription parsing and DB repair. */
export function canonicalProxyIdentity(raw: Record<string, unknown>): unknown {
  const chain = raw.__hiveChain;
  if (chain && typeof chain === "object") {
    const metadata = chain as Record<string, unknown>;
    return {
      kind: "chain",
      frontNodeHash: String(metadata.frontNodeHash ?? ""),
      targetNodeHash: String(metadata.targetNodeHash ?? "")
    };
  }
  if (typeof raw.uri === "string") {
    return { type: String(raw.type ?? "unknown").toLowerCase(), uri: normalizeProxyUri(raw.uri) };
  }
  return omitDisplayProxyMetadata(raw);
}

function normalizeProxyUri(uri: string): string {
  const value = uri.trim();
  const hashIndex = value.indexOf("#");
  const withoutFragment = hashIndex === -1 ? value : value.slice(0, hashIndex);
  try {
    const parsed = new URL(withoutFragment);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    const entries = Array.from(parsed.searchParams.entries()).sort(([a, av], [b, bv]) =>
      a === b ? av.localeCompare(bv) : a.localeCompare(b)
    );
    parsed.search = "";
    for (const [key, item] of entries) parsed.searchParams.append(key, item);
    return parsed.toString();
  } catch {
    return withoutFragment;
  }
}

function omitDisplayProxyMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitDisplayProxyMetadata);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !DISPLAY_ONLY_PROXY_KEYS.has(key.toLowerCase()))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, omitDisplayProxyMetadata(item)])
  );
}

export const nodeStatusSchema = z.enum(["active", "inactive", "untested", "failed"]);
export type NodeStatus = z.infer<typeof nodeStatusSchema>;

export const nodeLifecycleStatusSchema = z.enum([
  "candidate",
  "testing",
  "schedulable",
  "disabled",
  "draining",
  "cooling_down",
  "retired",
  "deleted"
]);
export type NodeLifecycleStatus = z.infer<typeof nodeLifecycleStatusSchema>;

export const proxyNodeKindSchema = z.enum(["direct", "chain"]);
export type ProxyNodeKind = z.infer<typeof proxyNodeKindSchema>;

export const proxyChainSchema = z.object({
  frontNodeHash: z.string().min(8),
  targetNodeHash: z.string().min(8),
  frontNodeName: z.string().min(1),
  targetNodeName: z.string().min(1)
});
export type ProxyChain = z.infer<typeof proxyChainSchema>;

export const subscriptionSourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["url", "file"]),
  value: z.string().min(1),
  enabled: z.boolean().default(true),
  lastContent: z.string().optional(),
  excludeKeywords: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type SubscriptionSource = z.infer<typeof subscriptionSourceSchema>;

export const proxyNodeSchema = z.object({
  hash: z.string().min(8),
  sourceId: z.string().min(1),
  name: z.string().min(1),
  originalName: z.string().min(1),
  type: z.string().min(1),
  region: z.string().default("unknown"),
  raw: z.record(z.unknown()),
  kind: proxyNodeKindSchema.optional(),
  chain: proxyChainSchema.optional(),
  status: nodeStatusSchema.default("untested"),
  lifecycleStatus: nodeLifecycleStatusSchema.default("candidate"),
  schedulable: z.boolean().default(false),
  protected: z.boolean().default(false),
  sub2apiProxyId: z.number().int().positive().optional().nullable(),
  qualityScore: z.number().min(0).max(100).optional().nullable(),
  assignedPort: z.number().int().min(1).max(65535).optional(),
  /** 旧格式 `openai:401,claude:405` —— 向后兼容；新逻辑写 lastTestTargets。 */
  lastTestStatus: z.string().optional(),
  /**
   * 语义已变更（P5-R 起）：从"OpenAI/Claude 测试中最大端到端延迟"改为
   * "服务直连代理 host:port 的 TCP 握手延迟（L1）"。
   * 普通节点不经过 mihomo、不经过业务目标，只反映"我方→代理"的网络距离。
   * 链式节点必须验证完整链路，因此记录经本地 listener 到业务目标的端到端延迟。
   */
  lastTestLatencyMs: z.number().int().nonnegative().optional(),
  /** 每个测试目标（openai / claude / ...）的独立结果，JSON 字符串。优先于 lastTestStatus 显示。 */
  lastTestTargets: z.string().optional(),
  // ADR 0003 orchestration intent
  intentRole: z.enum(["serving", "standby", "quarantined", "evicted", "paused"]).optional(),
  backoffUntil: z.string().optional().nullable(),
  backoffAttempts: z.number().int().min(0).optional(),
  healthScore: z.number().int().min(0).max(100).optional().nullable(),
  lastHealthCheck: z.string().optional().nullable(),
  /**
   * codex_login 实战反馈（P5-AS）。背景：节点能否进 egress 池原本只看 openai
   * 连通性测试（能否连上 auth.openai.com），但"能连上 ≠ 能过 Cloudflare Sentinel"。
   * 机房 IP 大多 openai 测试通过却被 Sentinel 挡，导致恢复盲目轮换、成功率极低。
   * 这里累计每个节点真实 codex_login 的成功/失败次数，驱动 egress 选择确定性地
   * 偏向"证明能过 Sentinel"的节点、惩罚反复失败的节点（对齐"禁止随机 fallback"）。
   *   codexLoginSuccess —— 经此节点出口 codex_login 成功累计
   *   codexLoginFailure —— 经此节点 network_or_proxy/sentinel 类失败累计
   *   codexLastOutcome  —— 最近一次结果，用于"刚失败的节点短期降级/排除"
   */
  codexLoginSuccess: z.number().int().nonnegative().default(0),
  codexLoginFailure: z.number().int().nonnegative().default(0),
  /**
   * 注册(codex_register)经此节点的成败累计。**与登录分开统计** —— 一个节点"能注册"
   * 不代表"能登录"(登录的 OAuth consent 链对出口 IP 更敏感)。登录选节点只看
   * codexLogin*,注册选节点只看 codexRegister*,避免互相误导。
   */
  codexRegisterSuccess: z.number().int().nonnegative().optional(),
  codexRegisterFailure: z.number().int().nonnegative().optional(),
  codexLastOutcome: z.enum(["success", "failure"]).optional().nullable(),
  codexLastOutcomeAt: z.string().optional().nullable(),
  /**
   * 保留节点（P5-AS）。用户手动标记的高质量代理，专用于账号注册/登录这类高风控
   * 敏感流程，作为"备用出口池"：
   *   - 注册：优先统一走保留节点（出生 IP 干净）；没有保留节点才回退普通节点。
   *   - 登录恢复：先复用账号"上次成功的节点"（sticky），失败后才启用保留节点，
   *     避免在一堆普通节点里瞎轮换触发更严重的账号风控。
   * 标记本身不影响日常 serving 绑定逻辑（仅影响 codex egress 选择优先级）。
   */
  codexReserved: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type ProxyNode = z.infer<typeof proxyNodeSchema>;

export const subscriptionImportPreviewItemSchema = z.object({
  hash: z.string().min(8),
  name: z.string().min(1),
  type: z.string().min(1),
  region: z.string().default("unknown"),
  action: z.enum(["import", "update", "skip_duplicate", "skip_existing", "skip_filtered"]),
  reason: z.string().min(1),
  matchedKeywords: z.array(z.string()).default([]),
  deletesExisting: z.boolean().default(false),
  existingAssignedPort: z.number().int().min(1).max(65535).optional()
});

export type SubscriptionImportPreviewItem = z.infer<typeof subscriptionImportPreviewItemSchema>;

export const subscriptionImportPreviewSchema = z.object({
  source: z.object({
    id: z.string().optional(),
    name: z.string().min(1),
    kind: z.enum(["url", "file"]),
    value: z.string().min(1),
    fetchedBytes: z.number().int().nonnegative()
  }),
  items: z.array(subscriptionImportPreviewItemSchema),
  summary: z.object({
    total: z.number().int().nonnegative(),
    importable: z.number().int().nonnegative(),
    updates: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    existing: z.number().int().nonnegative(),
    filtered: z.number().int().nonnegative(),
    deletedByFilter: z.number().int().nonnegative()
  })
});

export type SubscriptionImportPreview = z.infer<typeof subscriptionImportPreviewSchema>;

export const nodeDeletionPlanSchema = z.object({
  nodes: z.array(proxyNodeSchema),
  blockingAccounts: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string().min(1),
      proxyId: z.number().int().positive(),
      proxyName: z.string().min(1)
    })
  ),
  canDeleteNow: z.boolean(),
  requiresDrain: z.boolean(),
  message: z.string()
});

export type NodeDeletionPlan = z.infer<typeof nodeDeletionPlanSchema>;

export const operationJobStatusSchema = z.enum(["queued", "running", "success", "failed", "cancelled"]);
export type OperationJobStatus = z.infer<typeof operationJobStatusSchema>;

export const operationJobSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  status: operationJobStatusSchema,
  title: z.string().min(1),
  detail: z.string().default(""),
  steps: z.array(
    z.object({
      name: z.string().min(1),
      status: operationJobStatusSchema,
      detail: z.string().default("")
    })
  ),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type OperationJob = z.infer<typeof operationJobSchema>;

export const nodeTestTargetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url(),
  timeoutMs: z.number().int().positive().default(10_000)
});

export type NodeTestTarget = z.infer<typeof nodeTestTargetSchema>;
