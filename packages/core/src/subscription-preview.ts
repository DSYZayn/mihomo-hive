import {
  subscriptionImportPreviewSchema,
  type ProxyNode,
  type SubscriptionImportPreview,
  type SubscriptionSource
} from "@mihomo-hive/schemas";
import { parseSubscription } from "./subscription.js";

export interface BuildSubscriptionPreviewInput {
  source: Pick<SubscriptionSource, "id" | "name" | "kind" | "value">;
  content: string;
  existingNodes: ProxyNode[];
  excludeKeywords?: string[];
}

export function buildSubscriptionImportPreview(input: BuildSubscriptionPreviewInput): SubscriptionImportPreview {
  const parsed = parseSubscription(input.content, input.source.id ?? "preview");
  const existing = new Map(input.existingNodes.map((node) => [node.hash, node]));
  const seen = new Set<string>();
  const excludeKeywords = normalizeKeywords(input.excludeKeywords ?? []);

  const items = parsed.map((node) => {
    const matchedKeywords = matchKeywords(node, excludeKeywords);
    const existingNode = existing.get(node.hash);
    const duplicate = seen.has(node.hash);
    seen.add(node.hash);

    if (matchedKeywords.length > 0) {
      return previewItem(node, "skip_filtered", `命中过滤关键词：${matchedKeywords.join("、")}`, matchedKeywords, existingNode);
    }
    if (duplicate) {
      return previewItem(node, "skip_duplicate", "订阅内容中重复出现", [], existingNode);
    }
    if (existingNode && existingNode.sourceId === input.source.id) {
      return previewItem(node, "update", "已存在，将更新节点名称和原始配置", [], existingNode);
    }
    if (existingNode) {
      return previewItem(node, "skip_existing", "其他订阅源已导入同一节点", [], existingNode);
    }
    return previewItem(node, "import", "新节点，将作为候选节点导入", [], undefined);
  });

  return subscriptionImportPreviewSchema.parse({
    source: {
      id: input.source.id,
      name: input.source.name,
      kind: input.source.kind,
      value: input.source.value,
      fetchedBytes: input.content.length
    },
    items,
    summary: {
      total: items.length,
      importable: items.filter((item) => item.action === "import" || item.action === "update").length,
      updates: items.filter((item) => item.action === "update").length,
      duplicates: items.filter((item) => item.action === "skip_duplicate").length,
      existing: items.filter((item) => item.action === "skip_existing").length,
      filtered: items.filter((item) => item.action === "skip_filtered").length,
      deletedByFilter: items.filter((item) => item.action === "skip_filtered" && item.deletesExisting).length
    }
  });
}

export function filteredExistingNodeHashes(input: BuildSubscriptionPreviewInput): string[] {
  const preview = buildSubscriptionImportPreview(input);
  return preview.items.filter((item) => item.action === "skip_filtered" && item.deletesExisting).map((item) => item.hash);
}

export function filterPreviewImportableNodes(input: BuildSubscriptionPreviewInput): ProxyNode[] {
  const preview = buildSubscriptionImportPreview(input);
  const parsed = parseSubscription(input.content, input.source.id ?? "preview");
  return parsed.filter((_, index) => {
    const item = preview.items[index];
    return item?.action === "import" || item?.action === "update";
  });
}

function previewItem(
  node: ProxyNode,
  action: SubscriptionImportPreview["items"][number]["action"],
  reason: string,
  matchedKeywords: string[],
  existingNode: ProxyNode | undefined
): SubscriptionImportPreview["items"][number] {
  // 已经映射到 Sub2API 的节点不能因为订阅元数据变化而被删除，
  // 否则远端账号仍指向旧出口时会形成断路或 IP 漂移。
  const canDeleteExisting = Boolean(existingNode) && !existingNode?.sub2apiProxyId;
  return {
    hash: node.hash,
    name: node.name,
    type: node.type,
    region: node.region,
    action,
    reason,
    matchedKeywords,
    deletesExisting: action === "skip_filtered" && canDeleteExisting,
    ...(existingNode?.assignedPort ? { existingAssignedPort: existingNode.assignedPort } : {})
  };
}

function matchKeywords(node: ProxyNode, keywords: string[]): string[] {
  const haystack = `${node.name} ${node.originalName} ${node.region} ${node.type}`.toLowerCase();
  return keywords.filter((keyword) => haystack.includes(keyword.toLowerCase()));
}

function normalizeKeywords(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
