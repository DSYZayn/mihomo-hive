import {
  nodeDeletionPlanSchema,
  type NodeDeletionPlan,
  type ProxyAuth,
  type ProxyNode,
  type Sub2ApiAccountRecord,
  type Sub2ApiProxyRecord
} from "@mihomo-hive/schemas";

export function buildNodeDeletionPlan(input: {
  nodes: ProxyNode[];
  proxies: Sub2ApiProxyRecord[];
  accounts: Sub2ApiAccountRecord[];
  exportHost: string;
}): NodeDeletionPlan {
  const proxyByNode = new Map<string, Sub2ApiProxyRecord>();
  for (const node of input.nodes) {
    if (node.sub2apiProxyId) {
      const proxy = input.proxies.find((item) => item.id === node.sub2apiProxyId);
      if (proxy) {
        proxyByNode.set(node.hash, proxy);
        continue;
      }
    }
    if (node.assignedPort) {
      const proxy = input.proxies.find((item) => item.host === input.exportHost && item.port === node.assignedPort);
      if (proxy) {
        proxyByNode.set(node.hash, proxy);
      }
    }
  }

  const blockedProxyIds = new Map<number, string>();
  for (const proxy of proxyByNode.values()) {
    blockedProxyIds.set(proxy.id, proxy.name);
  }
  const blockingAccounts = input.accounts
    .filter((account) => account.proxy_id && blockedProxyIds.has(account.proxy_id))
    .map((account) => ({
      id: account.id,
      name: account.name,
      proxyId: Number(account.proxy_id),
      proxyName: blockedProxyIds.get(Number(account.proxy_id)) ?? `proxy-${account.proxy_id}`
    }));

  const requiresDrain = blockingAccounts.length > 0;
  return nodeDeletionPlanSchema.parse({
    nodes: input.nodes,
    blockingAccounts,
    requiresDrain,
    canDeleteNow: !requiresDrain && input.nodes.every((node) => !node.protected),
    message: requiresDrain
      ? `有 ${blockingAccounts.length} 个 Sub2API 账号仍绑定到这些节点，需要先排空。`
      : input.nodes.some((node) => node.protected)
        ? "包含受保护节点，请先解除保护。"
        : "这些节点当前没有 Sub2API 账号阻塞，可以删除。"
  });
}

export function mapLocalNodesToSub2ApiProxies(input: {
  nodes: ProxyNode[];
  proxies: Sub2ApiProxyRecord[];
  exportHost: string;
  proxyAuth?: ProxyAuth | undefined;
}): Array<{ hash: string; proxyId: number }> {
  const mappings: Array<{ hash: string; proxyId: number }> = [];
  for (const node of input.nodes) {
    if (!node.assignedPort) {
      continue;
    }
    const proxy = input.proxies.find((item) =>
      item.protocol === "socks5" && item.host === input.exportHost && item.port === node.assignedPort &&
      (item.username ?? "") === (input.proxyAuth?.username ?? "") &&
      (item.password ?? "") === (input.proxyAuth?.password ?? "")
    );
    if (proxy) {
      mappings.push({ hash: node.hash, proxyId: proxy.id });
    }
  }
  return mappings;
}
