import type { ProxyNode } from "@mihomo-hive/schemas";
import { proxyIdentityHash } from "./proxy-identity.js";

const CHAIN_SOURCE_ID = "__hive_chain__";

export interface CreateChainProxyInput {
  front: ProxyNode;
  target: ProxyNode;
  name?: string | undefined;
}

/** Create a deterministic two-hop node backed by Mihomo's dialer-proxy. */
export function createChainProxyNode(input: CreateChainProxyInput): ProxyNode {
  if (input.front.hash === input.target.hash) {
    throw new Error("前置节点和目标节点不能相同。");
  }
  if (input.front.kind === "chain" || input.target.kind === "chain") {
    throw new Error("当前只支持由两个普通节点组成的两跳链式代理。");
  }
  if ([input.front, input.target].some((node) => node.lifecycleStatus === "retired" || node.lifecycleStatus === "deleted")) {
    throw new Error("已退役或已删除的节点不能参与链式代理。");
  }
  if (!input.front.assignedPort) {
    throw new Error("前置节点必须先分配 Mihomo 端口，才能作为链式代理入口。");
  }

  const name = input.name?.trim() || `${input.front.name} → ${input.target.name}`;
  const chainMetadata = {
    frontNodeHash: input.front.hash,
    targetNodeHash: input.target.hash
  };
  const raw: Record<string, unknown> = {
    ...input.target.raw,
    name,
    "dialer-proxy": `hive-${input.front.assignedPort}-${input.front.hash.slice(0, 8)}`,
    __hiveChain: {
      ...chainMetadata,
      frontNodeName: input.front.name,
      targetNodeName: input.target.name
    }
  };
  const now = new Date().toISOString();
  return {
    hash: proxyIdentityHash(raw),
    sourceId: CHAIN_SOURCE_ID,
    name,
    originalName: name,
    type: input.target.type,
    region: input.target.region,
    raw,
    kind: "chain",
    chain: {
      ...chainMetadata,
      frontNodeName: input.front.name,
      targetNodeName: input.target.name
    },
    status: "untested",
    lifecycleStatus: "candidate",
    schedulable: false,
    protected: false,
    codexLoginSuccess: 0,
    codexLoginFailure: 0,
    codexReserved: false,
    createdAt: now,
    updatedAt: now
  };
}

export function isChainProxyNode(node: Pick<ProxyNode, "kind" | "raw">): boolean {
  return node.kind === "chain" || Boolean(node.raw.__hiveChain);
}

export function chainMetadataFromRaw(raw: Record<string, unknown>): ProxyNode["chain"] {
  const value = raw.__hiveChain;
  if (!value || typeof value !== "object") return undefined;
  const metadata = value as Record<string, unknown>;
  if (typeof metadata.frontNodeHash !== "string" || typeof metadata.targetNodeHash !== "string") return undefined;
  return {
    frontNodeHash: metadata.frontNodeHash,
    targetNodeHash: metadata.targetNodeHash,
    frontNodeName: typeof metadata.frontNodeName === "string" ? metadata.frontNodeName : metadata.frontNodeHash.slice(0, 8),
    targetNodeName: typeof metadata.targetNodeName === "string" ? metadata.targetNodeName : metadata.targetNodeHash.slice(0, 8)
  };
}
