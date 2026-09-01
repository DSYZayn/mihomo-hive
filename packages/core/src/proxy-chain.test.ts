import { describe, expect, it } from "vitest";
import { createChainProxyNode } from "./proxy-chain.js";
import type { ProxyNode } from "@mihomo-hive/schemas";

function node(hash: string, name: string, port?: number): ProxyNode {
  return {
    hash,
    sourceId: "source",
    name,
    originalName: name,
    type: "ss",
    region: "jp",
    raw: {
      name,
      type: "ss",
      server: `${name}.example.com`,
      port: 443,
      cipher: "aes-128-gcm",
      password: "secret"
    },
    status: "active",
    lifecycleStatus: "schedulable",
    schedulable: true,
    protected: false,
    ...(port ? { assignedPort: port } : {}),
    codexLoginSuccess: 0,
    codexLoginFailure: 0,
    codexReserved: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("createChainProxyNode", () => {
  it("creates a candidate with deterministic chain metadata and dialer-proxy", () => {
    const front = node("front000abcdef", "front", 10001);
    const target = node("target00abcdef", "target");
    const chain = createChainProxyNode({ front, target });
    expect(chain.kind).toBe("chain");
    expect(chain.lifecycleStatus).toBe("candidate");
    expect(chain.assignedPort).toBeUndefined();
    expect(chain.chain).toMatchObject({
      frontNodeHash: front.hash,
      targetNodeHash: target.hash
    });
    expect(chain.raw["dialer-proxy"]).toBe("hive-10001-front000");
    expect(chain.raw.__hiveChain).toMatchObject({
      frontNodeHash: front.hash,
      targetNodeHash: target.hash
    });
  });

  it("requires a front node port", () => {
    expect(() =>
      createChainProxyNode({
        front: node("front000abcdef", "front"),
        target: node("target00abcdef", "target")
      })
    ).toThrow("前置节点必须先分配");
  });
});
