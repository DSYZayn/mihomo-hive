import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChainProxyNode } from "@mihomo-hive/core";
import { HiveRepository, openSqlite, type HiveSqlite } from "@mihomo-hive/db";
import {
  proxyNodeSchema,
  runtimeConfigSchema,
  type ProxyNode,
  type Sub2ApiProxy,
  type Sub2ApiProxyRecord
} from "@mihomo-hive/schemas";
import { appRouter } from "./router.js";

describe("nodes.enableScheduling", () => {
  let sqlite: HiveSqlite;
  let repo: HiveRepository;
  let caller: ReturnType<typeof appRouter.createCaller>;
  let chain: ProxyNode;
  let target: ProxyNode;
  let remoteProxies: Sub2ApiProxyRecord[];
  let imported: Sub2ApiProxy[];
  let failures: Map<number, string>;
  let hiddenPorts: Set<number>;

  beforeEach(() => {
    sqlite = openSqlite(":memory:");
    repo = new HiveRepository(sqlite);
    repo.setSub2ApiConnection({
      baseUrl: "https://sub2api.example.com",
      adminApiKey: "test-key",
      timezone: "Asia/Shanghai",
      managedProxyPrefix: "MH-"
    });
    const front = node("front00001", "\u9999\u6e2f".repeat(12), 10001);
    target = node("target0001", "\u65e5\u672c".repeat(12), 10002);
    chain = { ...createChainProxyNode({ front, target }), assignedPort: 10003 };
    repo.upsertNodes([front, target, chain]);
    caller = appRouter.createCaller({ repo, config: runtimeConfigSchema.parse({}), authenticated: true });
    remoteProxies = [{
      id: 1,
      name: "MH-front",
      protocol: "socks5",
      host: "127.0.0.1",
      port: 10001,
      status: "active"
    }];
    imported = [];
    failures = new Map();
    hiddenPorts = new Set();

    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (url.pathname === "/api/v1/admin/proxies/data" && init?.method === "POST") {
        imported = (JSON.parse(String(init.body)) as { data: { proxies: Sub2ApiProxy[] } }).data.proxies;
        const errors: Array<{ kind: string; name: string; proxy_key: string; message: string }> = [];
        let created = 0;
        let reused = 0;
        for (const proxy of imported) {
          const error = failures.get(proxy.port) ??
            (Buffer.byteLength(proxy.name, "utf8") > 100 ? "name: value is greater than the required length" : undefined);
          if (error) {
            errors.push({ kind: "proxy", name: proxy.name, proxy_key: proxy.proxy_key, message: error });
          } else if (remoteProxies.some((remote) => remote.host === proxy.host && remote.port === proxy.port)) {
            reused += 1;
          } else {
            remoteProxies.push({ ...proxy, id: remoteProxies.length + 1 });
            created += 1;
          }
        }
        return Response.json({ code: 0, data: { proxy_created: created, proxy_reused: reused, proxy_failed: errors.length, errors } });
      }
      if (url.pathname === "/api/v1/admin/proxies") {
        const items = remoteProxies.filter((proxy) => !hiddenPorts.has(proxy.port));
        return Response.json({ code: 0, data: { items, total: items.length, pages: 1 } });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sqlite.close();
  });

  it("imports a long-named chain through its listener and persists the remote ID on retries", async () => {
    const result = await caller.nodes.enableScheduling({ hashes: [chain.hash] });

    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({
      protocol: "socks5",
      host: "127.0.0.1",
      port: 10003,
      proxy_key: "socks5|127.0.0.1|10003||",
      status: "active"
    });
    expect(result).toMatchObject({
      syncedToSub2api: true,
      mappedNodes: 1,
      summary: { proxy_created: 1, proxy_failed: 0 }
    });
    expect(repo.listNodes().find((node) => node.hash === chain.hash)).toMatchObject({
      lifecycleStatus: "schedulable",
      sub2apiProxyId: 2,
      name: chain.name
    });
    expect(await caller.nodes.enableScheduling({ hashes: [chain.hash] })).toMatchObject({
      syncedToSub2api: true,
      mappedNodes: 1,
      summary: { proxy_created: 0, proxy_reused: 1 }
    });
  });

  it("returns the remote import failure for the selected chain", async () => {
    failures.set(10003, "proxy storage unavailable");

    const result = await caller.nodes.enableScheduling({ hashes: [chain.hash] });

    expect(result).toMatchObject({
      syncedToSub2api: false,
      reason: "incomplete-sync",
      mappedNodes: 0,
      message: expect.stringContaining("proxy storage unavailable"),
      summary: { proxy_failed: 1, errors: [expect.objectContaining({ message: "proxy storage unavailable" })] }
    });
  });

  it("persists successful mappings and reports the failure in a partially imported batch", async () => {
    failures.set(10003, "proxy storage unavailable");

    const result = await caller.nodes.enableScheduling({ hashes: [target.hash, chain.hash] });

    expect(result).toMatchObject({
      syncedToSub2api: false,
      reason: "incomplete-sync",
      mappedNodes: 1,
      summary: { proxy_created: 1, proxy_failed: 1 }
    });
    expect(repo.listNodes().find((node) => node.hash === target.hash)?.sub2apiProxyId).toBe(2);
  });

  it("reports an incomplete sync when the selected proxy is missing from the live list", async () => {
    hiddenPorts.add(10003);

    const result = await caller.nodes.enableScheduling({ hashes: [chain.hash] });

    expect(result).toMatchObject({
      syncedToSub2api: false,
      reason: "incomplete-sync",
      mappedNodes: 0,
      message: expect.stringContaining(chain.name),
      summary: { proxy_created: 1, proxy_failed: 0 }
    });
  });
});

function node(hash: string, name: string, assignedPort: number): ProxyNode {
  return proxyNodeSchema.parse({
    hash,
    sourceId: "subscription",
    name,
    originalName: name,
    type: "socks5",
    raw: { name, type: "socks5", server: `${hash}.example.com`, port: 1080 },
    assignedPort,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z"
  });
}
