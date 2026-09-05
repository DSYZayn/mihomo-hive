import { stringify } from "yaml";
import type { ProxyNode, RuntimeConfig } from "@mihomo-hive/schemas";
import { parseProxyUri } from "./subscription.js";

export interface RenderedMihomo {
  yaml: string;
  egressMap: Array<{
    nodeHash: string;
    nodeName: string;
    proxyName: string;
    listenHost: string;
    port: number;
  }>;
}

/**
 * 外置 codex-tool agent 的出口配置。给定时,额外渲染一个**唯一对外**的鉴权 listener
 * (hive-codex),其上游绑到一个 `codex-egress` select 组(组里是全部节点 + DIRECT)。
 * 运行时 Hive 用 external-controller PUT /proxies/codex-egress 切换该组指向的节点,
 * 从而"单口 + 动态上游":对外只暴露一个鉴权端口,真实出口由 Hive 的选节点逻辑分发。
 */
export interface CodexEgressOptions {
  /** 对外监听端口(避开节点端口段)。 */
  port: number;
  /** 该口的绑定地址(只有这一个口对 LAN 暴露;其余节点口仍绑 listenHost)。 */
  bindHost: string;
  /** 运行时随机生成的鉴权用户/密码(不落库),拼进 users 与下发给 agent 的代理 URL。 */
  user: string;
  pass: string;
}

const CODEX_EGRESS_GROUP = "codex-egress";
const CODEX_LISTENER_NAME = "hive-codex";

export function renderMihomoConfig(
  nodes: ProxyNode[],
  config: RuntimeConfig,
  codexEgress?: CodexEgressOptions
): RenderedMihomo {
  // 渲染所有"有端口、非 retired/deleted"的节点为 listener。
  // 这样 candidate 节点也能被测试 / 用户验证可用性，而是否参与 Sub2API 账号调度
  // 是另外一回事（schedulable + active 才会被推送 / 接收账号）。
  const activeNodes = nodes
    .filter((node) => {
      if (!node.assignedPort) return false;
      const lifecycle = node.lifecycleStatus ?? "candidate";
      if (lifecycle === "retired" || lifecycle === "deleted") return false;
      if (node.kind === "chain") {
        const front = nodes.find((candidate) => candidate.hash === node.chain?.frontNodeHash);
        const target = nodes.find((candidate) => candidate.hash === node.chain?.targetNodeHash);
        if (!front?.assignedPort || !target) return false;
        const frontLifecycle = front.lifecycleStatus ?? "candidate";
        const targetLifecycle = target.lifecycleStatus ?? "candidate";
        if (frontLifecycle === "retired" || frontLifecycle === "deleted" || targetLifecycle === "retired" || targetLifecycle === "deleted") {
          return false;
        }
      }
      // 不能因为一次业务目标测试失败就拆掉 listener：Sub2API 可能仍有账号
      // 绑在这个固定端口。账号应先由 reconcile 迁走，节点进入 retired/deleted
      // 终态后才可移除 listener，避免制造 connection refused 型全量故障。
      return true;
    })
    .sort((a, b) => Number(a.assignedPort) - Number(b.assignedPort));

  const proxies = activeNodes.map((node) => {
    const target = node.chain ? nodes.find((candidate) => candidate.hash === node.chain?.targetNodeHash) : undefined;
    // 链式记录只保存节点关系；每次都从最后出口的当前定义渲染，避免订阅刷新后
    // 仍使用旧凭据或旧传输参数。
    const raw = renderableProxyRaw(node.kind === "chain" && target ? target.raw : node.raw);
    const front = node.chain ? nodes.find((candidate) => candidate.hash === node.chain?.frontNodeHash) : undefined;
    if (node.kind === "chain" && front?.assignedPort) {
      raw["dialer-proxy"] = proxyNameForNode(front);
    }
    return { ...raw, name: proxyNameForNode(node) };
  });

  const listeners = activeNodes.map((node) => ({
    name: `hive-${node.assignedPort}`,
    type: "mixed",
    listen: config.listenHost,
    port: node.assignedPort,
    udp: true,
    users: [],
    proxy: proxyNameForNode(node)
  }));

  // 外置 agent 出口:唯一对外鉴权口 + 可被 Hive 动态切上游的 select 组。
  const proxyGroups: Array<Record<string, unknown>> = [];
  if (codexEgress && codexEgress.port > 0) {
    listeners.push({
      name: CODEX_LISTENER_NAME,
      type: "mixed",
      listen: codexEgress.bindHost,
      port: codexEgress.port,
      udp: true,
      // 仅此口带鉴权。Mihomo listener 的 users 是 {username,password} 映射(非 "u:p" 字符串)。
      users: [{ username: codexEgress.user, password: codexEgress.pass }],
      proxy: CODEX_EGRESS_GROUP
    } as unknown as (typeof listeners)[number]);
    proxyGroups.push({
      name: CODEX_EGRESS_GROUP,
      type: "select",
      // 组成员 = 全部节点 + DIRECT 兜底(空池时仍合法,且 Hive 可临时切 DIRECT)
      proxies: [...proxies.map((p) => p.name as string), "DIRECT"]
    });
  }

  const document: Record<string, unknown> = {
    "allow-lan": false,
    "bind-address": config.listenHost,
    mode: "rule",
    "log-level": "info",
    ipv6: true,
    "external-controller": config.externalController,
    secret: config.externalControllerSecret,
    listeners,
    proxies,
    rules: ["MATCH,DIRECT"]
  };
  if (proxyGroups.length > 0) {
    document["proxy-groups"] = proxyGroups;
  }

  return {
    yaml: stringify(document, { lineWidth: 0 }),
    egressMap: activeNodes.map((node) => ({
      nodeHash: node.hash,
      nodeName: node.name,
      proxyName: proxyNameForNode(node),
      listenHost: config.listenHost,
      port: Number(node.assignedPort)
    }))
  };
}

/**
 * 节点对应的 mihomo proxy 名。**与位置无关**(用 assignedPort + hash 前 8 位),
 * 这样 Hive worker 能在不重渲染的情况下,凭节点 hash/port 算出同样的名字去切 codex-egress 组;
 * 也避免"加一个节点导致全体 proxy 名漂移"。
 */
export function proxyNameForNode(node: Pick<ProxyNode, "hash" | "assignedPort">): string {
  return `hive-${node.assignedPort}-${node.hash.slice(0, 8)}`;
}

function renderableProxyRaw(raw: Record<string, unknown>): Record<string, unknown> {
  const clean = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "__hiveChain"));
  // Older imports persisted VMess's Clash-style camelCase key. Mihomo expects
  // the canonical YAML spelling, so repair it when rendering existing rows.
  if (clean["alter-id"] === undefined && clean.alterId !== undefined) {
    clean["alter-id"] = clean.alterId;
  }
  delete clean.alterId;
  if (typeof clean.uri === "string" && (typeof clean.server !== "string" || typeof clean.port !== "number")) {
    const expanded = parseProxyUri(clean.uri, typeof clean.name === "string" ? clean.name : "proxy");
    if (expanded && typeof expanded.server === "string" && typeof expanded.port === "number" && expanded.uri === undefined) {
      return Object.fromEntries(Object.entries(expanded).filter(([key]) => key !== "uri" && key !== "__hiveChain"));
    }
    throw new Error(
      `无法渲染节点 "${String(clean.name ?? "proxy")}"：URI 协议未被 Hive 解析，请改用 Clash/Mihomo YAML 节点格式。`
    );
  }
  if (typeof clean.server === "string" && typeof clean.port === "number") delete clean.uri;
  return clean;
}
