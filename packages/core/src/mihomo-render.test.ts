import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { defaultRuntimeConfig, type ProxyNode } from "@mihomo-hive/schemas";
import { proxyNameForNode, renderMihomoConfig } from "./mihomo-render.js";

describe("renderMihomoConfig", () => {
  it("renders 300 fixed mixed listeners", () => {
    const nodes = Array.from({ length: 300 }, (_, index): ProxyNode => {
      const port = 10001 + index;
      return {
        hash: `${String(index).padStart(8, "0")}abcdef`,
        sourceId: "sample",
        name: `node-${index + 1}`,
        originalName: `node-${index + 1}`,
        type: "ss",
        region: "unknown",
        raw: {
          name: `node-${index + 1}`,
          type: "ss",
          server: `node-${index + 1}.example.com`,
          port: 443,
          cipher: "aes-128-gcm",
          password: "secret"
        },
        status: "active",
        lifecycleStatus: "schedulable",
        schedulable: true,
        protected: false,
        assignedPort: port,
        codexLoginSuccess: 0,
        codexLoginFailure: 0,
        codexReserved: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
    });

    const rendered = renderMihomoConfig(nodes, defaultRuntimeConfig);

    expect(rendered.egressMap).toHaveLength(300);
    expect(rendered.yaml).toContain("name: hive-10001");
    expect(rendered.yaml).toContain("port: 10300");
    expect(rendered.yaml).not.toContain("load-balance");
    expect(rendered.yaml).not.toContain("url-test");
    expect(rendered.yaml).not.toContain("fallback");
  });

  it("keeps a failed but non-retired node listening until accounts can drain", () => {
    const now = "2026-01-01T00:00:00.000Z";
    const failed: ProxyNode = {
      hash: "failed00abcdef",
      sourceId: "sample",
      name: "failed-node",
      originalName: "failed-node",
      type: "ss",
      region: "unknown",
      raw: { type: "ss", server: "node.example.com", port: 443, cipher: "aes-128-gcm", password: "secret" },
      status: "failed",
      lifecycleStatus: "cooling_down",
      schedulable: false,
      protected: false,
      sub2apiProxyId: 24,
      assignedPort: 10002,
      codexLoginSuccess: 0,
      codexLoginFailure: 0,
      codexReserved: false,
      createdAt: now,
      updatedAt: now
    };

    const rendered = renderMihomoConfig([failed], defaultRuntimeConfig);
    expect(rendered.egressMap.map((item) => item.port)).toEqual([10002]);
    expect(rendered.yaml).toContain("port: 10002");
  });

  it("renders a chain node with the current front proxy and hides Hive metadata", () => {
    const front: ProxyNode = {
      hash: "front000abcdef",
      sourceId: "sample",
      name: "front",
      originalName: "front",
      type: "ss",
      region: "unknown",
      raw: { type: "ss", server: "front.example.com", port: 443 },
      status: "active",
      lifecycleStatus: "schedulable",
      schedulable: true,
      protected: false,
      assignedPort: 10001,
      codexLoginSuccess: 0,
      codexLoginFailure: 0,
      codexReserved: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const target: ProxyNode = {
      ...front,
      hash: "target00abcdef",
      name: "target",
      originalName: "target",
      assignedPort: 10003,
      raw: { type: "ss", server: "current-target.example.com", port: 8443, password: "current-secret" }
    };
    const chain: ProxyNode = {
      ...front,
      hash: "chain000abcdef",
      name: "front → target",
      originalName: "front → target",
      kind: "chain",
      chain: { frontNodeHash: front.hash, targetNodeHash: "target00abcdef", frontNodeName: "front", targetNodeName: "target" },
      raw: {
        type: "ss",
        server: "stale-target.example.com",
        port: 443,
        password: "stale-secret",
        "dialer-proxy": "stale-name",
        __hiveChain: { frontNodeHash: front.hash, targetNodeHash: "target00abcdef" }
      },
      assignedPort: 10002
    };
    const rendered = renderMihomoConfig([front, target, chain], defaultRuntimeConfig);
    const document = parse(rendered.yaml) as { proxies: Array<Record<string, unknown>> };
    const chainProxy = document.proxies.find((proxy) => proxy.name === proxyNameForNode(chain));
    expect(chainProxy).toMatchObject({
      server: "current-target.example.com",
      port: 8443,
      password: "current-secret",
      "dialer-proxy": proxyNameForNode(front)
    });
    expect(chainProxy).not.toHaveProperty("__hiveChain");
  });

  it("expands a legacy URI-only target before rendering a chain", () => {
    const front: ProxyNode = {
      hash: "front000abcdef",
      sourceId: "sample",
      name: "HK",
      originalName: "HK",
      type: "ss",
      region: "unknown",
      raw: { type: "ss", server: "front.example.com", port: 443, cipher: "aes-128-gcm", password: "front" },
      status: "active",
      lifecycleStatus: "schedulable",
      schedulable: true,
      protected: false,
      assignedPort: 10001,
      codexLoginSuccess: 0,
      codexLoginFailure: 0,
      codexReserved: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const { assignedPort: _frontPort, ...frontWithoutPort } = front;
    const target: ProxyNode = {
      ...frontWithoutPort,
      hash: "target00abcdef",
      name: "US",
      originalName: "US",
      raw: { type: "trojan", uri: "trojan://target-secret@us.example.com:443?sni=edge.us.example.com#US" }
    };
    const chain: ProxyNode = {
      ...front,
      hash: "chain000abcdef",
      name: "HK -> US",
      originalName: "HK -> US",
      kind: "chain",
      chain: { frontNodeHash: front.hash, targetNodeHash: target.hash, frontNodeName: front.name, targetNodeName: target.name },
      raw: { type: "trojan", uri: "trojan://stale@stale.example.com:443#stale", __hiveChain: { frontNodeHash: front.hash, targetNodeHash: target.hash } },
      assignedPort: 10002
    };
    const document = parse(renderMihomoConfig([front, target, chain], defaultRuntimeConfig).yaml) as { proxies: Array<Record<string, unknown>> };
    const chainProxy = document.proxies.find((proxy) => proxy.name === proxyNameForNode(chain));
    expect(chainProxy).toMatchObject({
      type: "trojan",
      server: "us.example.com",
      port: 443,
      password: "target-secret",
      sni: "edge.us.example.com",
      "dialer-proxy": proxyNameForNode(front)
    });
    expect(chainProxy).not.toHaveProperty("uri");
  });

  it("expands a full-base64 Shadowsocks target before applying dialer-proxy", () => {
    const front: ProxyNode = {
      hash: "frontss000abcdef",
      sourceId: "sample",
      name: "HK",
      originalName: "HK",
      type: "ss",
      region: "unknown",
      raw: { type: "ss", server: "front.example.com", port: 443, cipher: "aes-128-gcm", password: "front" },
      status: "active",
      lifecycleStatus: "schedulable",
      schedulable: true,
      protected: false,
      assignedPort: 10001,
      codexLoginSuccess: 0,
      codexLoginFailure: 0,
      codexReserved: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const target: ProxyNode = {
      ...front,
      hash: "targetss000abcdef",
      name: "US",
      originalName: "US",
      raw: {
        type: "ss",
        uri: `ss://${Buffer.from("aes-256-gcm:target@example.com:443", "utf8").toString("base64url")}#US`
      }
    };
    const chain: ProxyNode = {
      ...front,
      hash: "chainss000abcdef",
      name: "HK -> US",
      originalName: "HK -> US",
      kind: "chain",
      chain: { frontNodeHash: front.hash, targetNodeHash: target.hash, frontNodeName: front.name, targetNodeName: target.name },
      raw: { type: "ss", uri: "ss://stale#stale", __hiveChain: { frontNodeHash: front.hash, targetNodeHash: target.hash } },
      assignedPort: 10002
    };

    const document = parse(renderMihomoConfig([front, target, chain], defaultRuntimeConfig).yaml) as { proxies: Array<Record<string, unknown>> };
    const chainProxy = document.proxies.find((proxy) => proxy.name === proxyNameForNode(chain));
    expect(chainProxy).toMatchObject({
      type: "ss",
      server: "example.com",
      port: 443,
      cipher: "aes-256-gcm",
      password: "target",
      "dialer-proxy": proxyNameForNode(front)
    });
    expect(chainProxy).not.toHaveProperty("uri");
  });
});

describe("renderMihomoConfig codex-egress (外置 agent)", () => {
  const node = (i: number): ProxyNode => ({
    hash: `${String(i).padStart(8, "0")}aa`,
    sourceId: "s",
    name: `n${i}`,
    originalName: `n${i}`,
    type: "ss",
    region: "x",
    raw: { name: `n${i}`, type: "ss", server: "h", port: 1, cipher: "aes-128-gcm", password: "p" },
    status: "active",
    lifecycleStatus: "schedulable",
    schedulable: true,
    protected: false,
    assignedPort: 10001 + i,
    codexLoginSuccess: 0,
    codexLoginFailure: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }) as unknown as ProxyNode;

  it("不传 codexEgress 时不渲染 codex 口与 proxy-groups（向后兼容）", () => {
    const r = renderMihomoConfig([node(1)], defaultRuntimeConfig);
    expect(r.yaml).not.toContain("hive-codex");
    expect(r.yaml).not.toContain("codex-egress");
    expect(r.yaml).not.toContain("proxy-groups");
  });

  it("传 codexEgress 时渲染唯一鉴权口 + codex-egress select 组(含全部节点+DIRECT)", () => {
    const r = renderMihomoConfig([node(1), node(2)], defaultRuntimeConfig, {
      port: 19000,
      bindHost: "0.0.0.0",
      user: "u1",
      pass: "p1"
    });
    expect(r.yaml).toContain("hive-codex");
    expect(r.yaml).toContain("19000");
    expect(r.yaml).toContain("username: u1");
    expect(r.yaml).toContain("password: p1");
    expect(r.yaml).toContain("proxy-groups");
    expect(r.yaml).toContain("codex-egress");
    expect(r.yaml).toContain("type: select");
    expect(r.yaml).toContain("DIRECT");
    // 组成员应包含两个节点的 proxyName
    expect(r.yaml).toMatch(/hive-10002-/);
    expect(r.yaml).toMatch(/hive-10003-/);
  });
});
