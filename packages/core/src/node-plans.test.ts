import { describe, expect, it } from "vitest";
import { buildNodeDeletionPlan, mapLocalNodesToSub2ApiProxies } from "./node-plans.js";
import type { ProxyNode, Sub2ApiAccountRecord, Sub2ApiProxyRecord } from "@mihomo-hive/schemas";

describe("node deletion plans", () => {
  it("requires drain when Sub2API accounts still use selected node proxies", () => {
    const nodes = [node("hash-0001", 10001)];
    const proxies = [proxy(7, 10001)];
    const accounts = [account(99, 7)];

    const plan = buildNodeDeletionPlan({ nodes, proxies, accounts, exportHost: "127.0.0.1" });

    expect(plan.canDeleteNow).toBe(false);
    expect(plan.requiresDrain).toBe(true);
    expect(plan.blockingAccounts.map((item) => item.id)).toEqual([99]);
  });

  it("maps local node ports back to Sub2API proxy ids", () => {
    expect(
      mapLocalNodesToSub2ApiProxies({
        nodes: [node("hash-0001", 10001)],
        proxies: [proxy(7, 10001), proxy(8, 10002)],
        exportHost: "127.0.0.1"
      })
    ).toEqual([{ hash: "hash-0001", proxyId: 7 }]);
  });

  it("matches the complete authenticated connection rather than a stale proxy on the same port", () => {
    const proxyAuth = { username: "hive", password: "secret" };
    const proxies = [
      proxy(1, 10001),
      { ...proxy(2, 10001), ...proxyAuth, password: "old" },
      { ...proxy(3, 10001), ...proxyAuth, protocol: "http" },
      { ...proxy(4, 10001), ...proxyAuth }
    ];
    const input = { nodes: [node("hash-0001", 10001)], proxies, exportHost: "127.0.0.1", proxyAuth };
    expect(mapLocalNodesToSub2ApiProxies(input)).toEqual([{ hash: "hash-0001", proxyId: 4 }]);
    expect(mapLocalNodesToSub2ApiProxies({ ...input, proxies: proxies.slice(0, 3) })).toEqual([]);
    expect(mapLocalNodesToSub2ApiProxies({ ...input, proxyAuth: undefined })).toEqual([{ hash: "hash-0001", proxyId: 1 }]);
  });
});

function node(hash: string, assignedPort: number): ProxyNode {
  return {
    hash,
    sourceId: "source",
    name: hash,
    originalName: hash,
    type: "ss",
    region: "jp",
    raw: { name: hash, type: "ss" },
    status: "active",
    lifecycleStatus: "schedulable",
    schedulable: true,
    protected: false,
    assignedPort,
    codexLoginSuccess: 0,
    codexLoginFailure: 0,
    codexReserved: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function proxy(id: number, port: number): Sub2ApiProxyRecord {
  return {
    id,
    name: `proxy-${id}`,
    protocol: "socks5",
    host: "127.0.0.1",
    port,
    status: "active"
  };
}

function account(id: number, proxyId: number): Sub2ApiAccountRecord {
  return {
    id,
    name: `account-${id}`,
    platform: "openai",
    status: "active",
    proxy_id: proxyId
  };
}
