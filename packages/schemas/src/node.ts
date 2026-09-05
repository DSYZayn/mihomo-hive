import { z } from "zod";

const NON_IDENTITY_PROXY_KEYS = new Set([
  "name",
  "ps",
  "remarks",
  "remark",
  "display-name",
  "provider",
  "provider-name",
  "provider-id",
  "sub",
  "sub-id",
  "subscription",
  "subscription-id",
  "subscription-name",
  "source",
  "source-id",
  "tag",
  "label",
  "description"
]);

const NON_IDENTITY_URI_QUERY_KEYS = new Set([
  "provider",
  "provider-id",
  "sub",
  "sub-id",
  "subscription",
  "subscription-id",
  "source",
  "source-id",
  "tag",
  "label"
]);

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
  const legacyVmess = parseLegacyVmessIdentity(raw);
  if (legacyVmess) return applyIdentityDefaults(legacyVmess);
  if (typeof raw.uri === "string") {
    const parsed = parseUriIdentity(raw.uri);
    if (parsed) return applyIdentityDefaults(parsed);
    return { type: String(raw.type ?? "unknown").toLowerCase(), uri: normalizeProxyUri(raw.uri) };
  }
  return applyIdentityDefaults(omitNonIdentityProxyMetadata(raw) as Record<string, unknown>);
}

/** Normalize the VMess shape persisted by versions before the URI parser rewrite. */
function parseLegacyVmessIdentity(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  if (normalizeProxyType(String(raw.type ?? "")) !== "vmess") return undefined;
  if (!raw.rawVmess || typeof raw.rawVmess !== "object" || Array.isArray(raw.rawVmess)) return undefined;

  const data = raw.rawVmess as Record<string, unknown>;
  const server = typeof data.add === "string" ? data.add : undefined;
  const port = Number(data.port);
  const uuid = typeof data.id === "string" ? data.id : undefined;
  if (!server || !Number.isInteger(port) || port <= 0 || !uuid) return undefined;

  const result: Record<string, unknown> = {
    type: "vmess",
    server,
    port,
    uuid,
    "alter-id": Number(data.aid ?? 0),
    cipher: data.scy ?? "auto",
    tls: data.tls === true || data.tls === "tls"
  };
  if (typeof data.net === "string" && data.net) result.network = data.net;
  if (typeof data.host === "string" || typeof data.path === "string") {
    result["ws-opts"] = {
      ...(typeof data.path === "string" ? { path: data.path } : {}),
      ...(typeof data.host === "string" ? { headers: { Host: data.host } } : {})
    };
  }
  return omitNonIdentityProxyMetadata(result) as Record<string, unknown>;
}

function normalizeProxyUri(uri: string): string {
  const value = uri.trim();
  const hashIndex = value.indexOf("#");
  const withoutFragment = hashIndex === -1 ? value : value.slice(0, hashIndex);
  try {
    const parsed = new URL(withoutFragment);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    const entries = Array.from(parsed.searchParams.entries())
      .filter(([key]) => !NON_IDENTITY_URI_QUERY_KEYS.has(normalizeProxyKey(key)))
      .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
    parsed.search = "";
    for (const [key, item] of entries) parsed.searchParams.append(key, item);
    return parsed.toString();
  } catch {
    return withoutFragment;
  }
}

function omitNonIdentityProxyMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => omitNonIdentityProxyMetadata(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !NON_IDENTITY_PROXY_KEYS.has(normalizeProxyKey(key)))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => {
        const normalizedKey = normalizeProxyKey(key);
        const canonicalKey = canonicalProxyKey(normalizedKey);
        if (typeof item === "string" && ["server", "host", "sni", "servername", "server-name", "peer"].includes(normalizedKey)) {
          return [canonicalKey, item.trim().toLowerCase()];
        }
        if (normalizedKey === "type" && typeof item === "string") {
          return [canonicalKey, normalizeProxyType(item)];
        }
        if (normalizedKey === "port" && typeof item === "string" && /^\d+$/.test(item.trim())) {
          return [canonicalKey, Number(item.trim())];
        }
        if (normalizedKey === "tls" && typeof item === "string") {
          return [canonicalKey, item.trim().toLowerCase() === "true"];
        }
        return [canonicalKey, omitNonIdentityProxyMetadata(item)];
      })
  );
}

function normalizeProxyKey(key: string): string {
  return key
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replaceAll("_", "-");
}

function canonicalProxyKey(key: string): string {
  switch (key) {
    case "add":
    case "address":
      return "server";
    case "servername":
    case "server-name":
    case "peer":
      return "sni";
    case "aid":
      return "alter-id";
    case "scy":
      return "cipher";
    case "net":
      return "network";
    case "pwd":
    case "pass":
      return "password";
    default:
      return key;
  }
}

function normalizeProxyType(value: string): string {
  const type = value.trim().toLowerCase();
  if (type === "socks") return "socks5";
  if (type === "hy2" || type === "hysteria") return "hysteria2";
  return type;
}

function applyIdentityDefaults(value: Record<string, unknown>): Record<string, unknown> {
  const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
  if (type === "trojan" && value.tls === undefined) value.tls = true;
  if (type === "vless") {
    if (value.encryption === undefined) value.encryption = "none";
    if (value.security === "none" || value.security === "tls" || value.security === "reality") delete value.security;
    if (value.network === "tcp") delete value.network;
  }
  if ((type === "trojan" || type === "hysteria2") && value.network === "tcp") {
    delete value.network;
  }
  if (type === "vmess") {
    if (value["alter-id"] === undefined) value["alter-id"] = 0;
    if (value.cipher === undefined) value.cipher = "auto";
    if (value.tls === undefined) value.tls = false;
    if (value.network === undefined) value.network = "tcp";
  }
  return value;
}

/** Canonicalize legacy URI-only rows so refreshes can merge them with YAML. */
function parseUriIdentity(uri: string): Record<string, unknown> | undefined {
  const value = uri.trim();
  const protocol = value.match(/^([a-z0-9+.-]+):\/\//i)?.[1]?.toLowerCase();
  if (!protocol) return undefined;
  if (protocol === "vmess") {
    try {
      const data = JSON.parse(decodeBase64(value.slice("vmess://".length).split("#", 1)[0] ?? "")) as Record<string, unknown>;
      return omitNonIdentityProxyMetadata({
        type: "vmess",
        server: data.add,
        port: Number(data.port),
        uuid: data.id,
        "alter-id": Number(data.aid ?? 0),
        cipher: data.scy ?? "auto",
        tls: data.tls === "tls",
        network: data.net,
        ...(data.host || data.path
          ? {
              "ws-opts": {
                ...(data.path ? { path: data.path } : {}),
                ...(data.host ? { headers: { Host: data.host } } : {})
              }
            }
          : {})
      }) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  if (protocol === "ssr") {
    try {
      const decoded = decodeBase64(value.slice("ssr://".length).split("#", 1)[0] ?? "");
      const [endpoint = "", query = ""] = decoded.split("/?", 2);
      const [server, port, ssrProtocol, method, obfs, encodedPassword] = endpoint.split(":");
      if (!server || !port || !ssrProtocol || !method || !obfs || !encodedPassword) return undefined;
      const result: Record<string, unknown> = {
        type: "ssr",
        server,
        port: Number(port),
        protocol: ssrProtocol,
        cipher: method,
        obfs,
        password: decodeBase64(encodedPassword)
      };
      for (const [key, item] of new URLSearchParams(query)) {
        if (key === "obfsparam") result["obfs-param"] = decodeBase64(item);
        if (key === "protoparam") result["protocol-param"] = decodeBase64(item);
      }
      return omitNonIdentityProxyMetadata(result) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  if (protocol === "ss") {
    const fullBase64 = parseFullBase64ShadowsocksIdentity(value);
    if (fullBase64) return fullBase64;
  }
  try {
    const parsed = new URL(value);
    const type = normalizeProxyType(protocol);
    const result: Record<string, unknown> = { type, server: parsed.hostname };
    if (parsed.port) result.port = Number(parsed.port);
    const username = safeDecodeUri(parsed.username);
    const password = safeDecodeUri(parsed.password);
    if (type === "ss") {
      const decodedUser = decodeBase64(username);
      const methodAndPassword = decodedUser.includes(":") ? decodedUser : `${username}:${password}`;
      const separator = methodAndPassword.indexOf(":");
      if (separator > 0) {
        result.cipher = methodAndPassword.slice(0, separator);
        result.password = methodAndPassword.slice(separator + 1);
      }
      applyShadowsocksPluginIdentity(result, parsed.searchParams.get("plugin"));
      return omitNonIdentityProxyMetadata(result) as Record<string, unknown>;
    }
    if (type === "trojan") {
      result.password = username || password;
      result.tls = true;
      applyCommonTransportIdentity(result, parsed.searchParams);
    } else if (type === "vless") {
      result.uuid = username;
      result.encryption = parsed.searchParams.get("encryption") ?? "none";
      applyVlessTransportIdentity(result, parsed.searchParams);
    } else if (type === "hysteria2") {
      result.password = username || password;
      applyCommonTransportIdentity(result, parsed.searchParams);
      const obfs = parsed.searchParams.get("obfs");
      const obfsPassword = parsed.searchParams.get("obfs-password");
      if (obfs) result.obfs = obfs;
      if (obfsPassword) result["obfs-password"] = obfsPassword;
    } else if (type === "tuic") {
      const [uuid, inlinePassword] = username.split(":", 2);
      result.uuid = uuid;
      result.password = inlinePassword || password;
      for (const key of ["congestion_control", "udp_relay_mode", "zero_rtt"]) {
        const item = parsed.searchParams.get(key);
        if (item) result[key.replaceAll("_", "-")] = item;
      }
      applyCommonTransportIdentity(result, parsed.searchParams);
    } else if (type === "socks5" || type === "http") {
      if (username) result.username = username;
      if (password) result.password = password;
      applyCommonTransportIdentity(result, parsed.searchParams);
    } else {
      if (username) result.username = username;
      if (password) result.password = password;
      applyCommonTransportIdentity(result, parsed.searchParams);
      result.uri = normalizeProxyUri(value);
    }
    return omitNonIdentityProxyMetadata(result) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function applyCommonTransportIdentity(result: Record<string, unknown>, params: URLSearchParams): void {
  const sni = params.get("sni") ?? params.get("servername") ?? params.get("peer");
  if (sni) result.sni = sni;
  const insecure = params.get("insecure") ?? params.get("allow-insecure");
  if (insecure) result["skip-cert-verify"] = insecure === "1" || insecure.toLowerCase() === "true";
  const alpn = params.get("alpn");
  if (alpn) result.alpn = alpn.split(",").map((item) => item.trim()).filter(Boolean);
  const network = params.get("type") ?? params.get("network");
  if (network && network !== "tcp") result.network = network;
  const path = params.get("path");
  const host = params.get("host");
  if (path || host) {
    result["ws-opts"] = {
      ...(path ? { path } : {}),
      ...(host ? { headers: { Host: host } } : {})
    };
  }
}

function applyVlessTransportIdentity(result: Record<string, unknown>, params: URLSearchParams): void {
  const security = params.get("security");
  if (security === "tls" || security === "reality") result.tls = true;
  if (security === "reality") {
    const publicKey = params.get("pbk");
    const shortId = params.get("sid");
    result["reality-opts"] = {
      ...(publicKey ? { "public-key": publicKey } : {}),
      ...(shortId ? { "short-id": shortId } : {})
    };
  }
  const flow = params.get("flow");
  if (flow) result.flow = flow;
  const fingerprint = params.get("fp");
  if (fingerprint) result["client-fingerprint"] = fingerprint;
  applyCommonTransportIdentity(result, params);
  if (result.network === "grpc") {
    const serviceName = params.get("serviceName") ?? params.get("service-name");
    if (serviceName) result["grpc-opts"] = { "grpc-service-name": serviceName };
  }
}

/** Canonical identity for SIP002's full-base64 `ss://` form. */
function parseFullBase64ShadowsocksIdentity(value: string): Record<string, unknown> | undefined {
  const body = value.slice("ss://".length).split("#", 1)[0] ?? "";
  const queryIndex = body.indexOf("?");
  const encoded = queryIndex === -1 ? body : body.slice(0, queryIndex).replace(/\/$/, "");
  if (!encoded || encoded.includes("@") || encoded.includes(":")) return undefined;
  const decoded = safeDecodeUri(decodeBase64(encoded));
  const at = decoded.lastIndexOf("@");
  if (at <= 0) return undefined;
  const credentials = decoded.slice(0, at);
  const endpoint = decoded.slice(at + 1);
  const separator = credentials.indexOf(":");
  if (separator <= 0 || !endpoint) return undefined;
  try {
    const parsed = new URL(`ss://${endpoint}`);
    if (!parsed.hostname || !parsed.port) return undefined;
    const result: Record<string, unknown> = {
      type: "ss",
      server: parsed.hostname,
      port: Number(parsed.port),
      cipher: credentials.slice(0, separator),
      password: credentials.slice(separator + 1)
    };
    if (queryIndex !== -1) {
      applyShadowsocksPluginIdentity(result, body.slice(queryIndex + 1).replace(/^plugin=/, ""));
    }
    return omitNonIdentityProxyMetadata(result) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function applyShadowsocksPluginIdentity(result: Record<string, unknown>, plugin: string | null): void {
  if (!plugin) return;
  const [name, ...options] = safeDecodeUri(plugin).split(";");
  if (!name) return;
  result.plugin = name;
  const pluginOpts: Record<string, string> = {};
  for (const option of options) {
    const separator = option.indexOf("=");
    if (separator > 0) pluginOpts[option.slice(0, separator)] = option.slice(separator + 1);
  }
  if (Object.keys(pluginOpts).length > 0) result["plugin-opts"] = pluginOpts;
}

function decodeBase64(value: string): string {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    return decodeURIComponent(
      Array.from(atob(normalized), (char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`).join("")
    );
  } catch {
    return value;
  }
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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
