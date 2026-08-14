import { describe, expect, it } from "vitest";
import {
  defaultOrchestrationSpec,
  type OrchestrationSpec,
  type ProxyNode,
  type Sub2ApiAccountRecord,
  type Sub2ApiProxyRecord
} from "@mihomo-hive/schemas";
import { reconcile, validateIntakeAgainstSpec } from "./reconcile.js";

const NOW = new Date("2026-05-27T12:00:00Z");
const PREFIX = "MH-";

function buildProxy(input: Partial<Sub2ApiProxyRecord> & { id: number; name?: string }): Sub2ApiProxyRecord {
  return {
    id: input.id,
    name: input.name ?? `MH-node-${input.id}`,
    protocol: "socks5",
    host: input.host ?? "127.0.0.1",
    port: input.port ?? 10000 + input.id,
    status: input.status ?? "active",
    ...(input.account_count !== undefined ? { account_count: input.account_count } : {})
  };
}

function buildNode(input: Partial<ProxyNode> & { hash: string; sub2apiProxyId: number }): ProxyNode {
  return {
    hash: input.hash,
    sourceId: "src",
    name: input.name ?? `local-${input.sub2apiProxyId}`,
    originalName: input.name ?? `local-${input.sub2apiProxyId}`,
    type: "vless",
    region: "jp",
    raw: {},
    status: "active",
    lifecycleStatus: input.lifecycleStatus ?? "schedulable",
    schedulable: true,
    protected: input.protected ?? false,
    sub2apiProxyId: input.sub2apiProxyId,
    assignedPort: 10000 + input.sub2apiProxyId,
    intentRole: input.intentRole ?? "serving",
    ...(input.backoffUntil !== undefined ? { backoffUntil: input.backoffUntil } : {}),
    backoffAttempts: input.backoffAttempts ?? 0,
    codexLoginSuccess: 0,
    codexLoginFailure: 0,
    codexReserved: false,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  };
}

function buildAccount(input: { id: number; proxy_id: number | null; name?: string }): Sub2ApiAccountRecord {
  return {
    id: input.id,
    name: input.name ?? `acct-${input.id}`,
    proxy_id: input.proxy_id
  };
}

function specWith(overrides: Partial<OrchestrationSpec>): OrchestrationSpec {
  return { ...defaultOrchestrationSpec, ...overrides };
}

describe("reconcile", () => {
  it("paused spec produces dry-run output (no applied changes, intents still built)", () => {
    const proxies = [buildProxy({ id: 1 }), buildProxy({ id: 2 })];
    const localNodes = [
      buildNode({ hash: "n1xxxxxx", sub2apiProxyId: 1 }),
      buildNode({ hash: "n2xxxxxx", sub2apiProxyId: 2 })
    ];
    const accounts = [buildAccount({ id: 100, proxy_id: null })];

    const result = reconcile({
      now: NOW,
      spec: specWith({ enabled: false }),
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX
    });

    expect(result.skippedReason).toBe("paused");
    expect(result.appliedChanges).toHaveLength(0);
    expect(result.plannedChanges.length).toBeGreaterThan(0); // dry-run 仍规划
    expect(result.nodeIntents).toHaveLength(2);
  });

  it("no changes needed → skippedReason = no_change", () => {
    const proxies = [buildProxy({ id: 1 })];
    const localNodes = [buildNode({ hash: "n1xxxxxx", sub2apiProxyId: 1 })];
    const accounts = [buildAccount({ id: 100, proxy_id: 1 })];

    const result = reconcile({
      now: NOW,
      spec: defaultOrchestrationSpec,
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX
    });

    expect(result.plannedChanges).toEqual([]);
    expect(result.skippedReason).toBe("no_change");
  });

  it("intake drain: accounts on intake proxy get rerouted to serving nodes", () => {
    const intake = buildProxy({ id: 99, name: "intake-handoff" }); // 不带 MH- 前缀
    const serving = [buildProxy({ id: 1 }), buildProxy({ id: 2 })];
    const localNodes = [
      buildNode({ hash: "n1xxxxxx", sub2apiProxyId: 1 }),
      buildNode({ hash: "n2xxxxxx", sub2apiProxyId: 2 })
    ];
    const accounts = [
      buildAccount({ id: 10, proxy_id: 99 }),
      buildAccount({ id: 11, proxy_id: 99 }),
      buildAccount({ id: 12, proxy_id: 99 })
    ];

    const result = reconcile({
      now: NOW,
      spec: specWith({ intake: { proxyId: 99, bypassGraceBatch: true } }),
      localNodes,
      remoteProxies: [intake, ...serving],
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX
    });

    const drainChanges = result.plannedChanges.filter((c) => c.kind === "drain_intake");
    expect(drainChanges).toHaveLength(3);
    for (const change of drainChanges) {
      expect(change.fromProxyId).toBe(99);
      expect([1, 2]).toContain(change.toProxyId);
    }
  });

  it("protected proxies are excluded from assignable pool and their accounts never move", () => {
    const protectedProxy = buildProxy({ id: 50, name: "WRT-home", host: "192.168.5.8" });
    const serving = [buildProxy({ id: 1 })];
    const localNodes = [buildNode({ hash: "n1xxxxxx", sub2apiProxyId: 1 })];
    const accounts = [
      buildAccount({ id: 10, proxy_id: 50 }), // 受保护账号
      buildAccount({ id: 20, proxy_id: null }) // 未绑定，应分配到 #1
    ];

    const result = reconcile({
      now: NOW,
      spec: specWith({
        protectedRule: {
          proxyIds: [],
          nameIncludes: "WRT",
          hostIncludes: "",
          countryIncludes: "",
          regionIncludes: "",
          status: ""
        }
      }),
      localNodes,
      remoteProxies: [protectedProxy, ...serving],
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX
    });

    // 账号 10 不能出现在 planned 里（受保护）
    expect(result.plannedChanges.find((c) => c.accountId === 10)).toBeUndefined();
    // 账号 20 应被 bind_missing 到 #1
    const account20 = result.plannedChanges.find((c) => c.accountId === 20);
    expect(account20).toBeDefined();
    expect(account20?.kind).toBe("bind_missing");
    expect(account20?.toProxyId).toBe(1);
  });

  it("overload triggers rebalance with capped per-tick migrations", () => {
    const proxies = [
      buildProxy({ id: 1 }),
      buildProxy({ id: 2 }),
      buildProxy({ id: 3 })
    ];
    const localNodes = proxies.map((p) =>
      buildNode({ hash: `n${p.id}xxxxxx`, sub2apiProxyId: p.id })
    );
    // 12 个账号全堆在 #1 → target = ceil(12/3) = 4，overload upper = 4*1.2 = 5
    // 节点 1 实际承载 12 > 5，需要外迁 (12 - 4) = 8 个
    const accounts = Array.from({ length: 12 }, (_, i) =>
      buildAccount({ id: 100 + i, proxy_id: 1 })
    );

    const result = reconcile({
      now: NOW,
      spec: specWith({
        // 关掉灰度阀让规划全跑出来，但保留 stickiness.perTickMigrationCap
        graceBatchPercent: 100,
        graceBatchAbs: 999,
        stickiness: { strategy: "stable-hash", rebalanceTriggerPercent: 15, perTickMigrationCap: 3 }
      }),
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX
    });

    const overloadChanges = result.plannedChanges.filter((c) => c.kind === "rebalance_overload");
    expect(overloadChanges.length).toBe(8); // planned full
    const appliedOverload = result.appliedChanges.filter((c) => c.kind === "rebalance_overload");
    expect(appliedOverload.length).toBe(3); // 受 perTickMigrationCap 限制
  });

  it("graceBatch caps general changes but lets intake drain pass through (bypass=true)", () => {
    const intake = buildProxy({ id: 99 });
    const serving = [buildProxy({ id: 1 }), buildProxy({ id: 2 })];
    const localNodes = serving.map((p) =>
      buildNode({ hash: `n${p.id}xxxxxx`, sub2apiProxyId: p.id })
    );

    // 5 个账号在 intake + 5 个未绑定（bind_missing）
    const accounts = [
      ...Array.from({ length: 5 }, (_, i) => buildAccount({ id: 100 + i, proxy_id: 99 })),
      ...Array.from({ length: 5 }, (_, i) => buildAccount({ id: 200 + i, proxy_id: null }))
    ];

    const result = reconcile({
      now: NOW,
      spec: specWith({
        intake: { proxyId: 99, bypassGraceBatch: true },
        graceBatchPercent: 100,
        graceBatchAbs: 2 // 强制 general cap = 2
      }),
      localNodes,
      remoteProxies: [intake, ...serving],
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX
    });

    const intakeApplied = result.appliedChanges.filter((c) => c.kind === "drain_intake");
    const generalApplied = result.appliedChanges.filter((c) => c.kind === "bind_missing");
    expect(intakeApplied.length).toBe(5); // bypass，全部通过
    expect(generalApplied.length).toBe(2); // 受 general cap = 2 限制
  });

  it("quarantined node's accounts stay put (stability-first invariant)", () => {
    const proxies = [buildProxy({ id: 1 }), buildProxy({ id: 2 })];
    const localNodes = [
      buildNode({
        hash: "n1xxxxxx",
        sub2apiProxyId: 1,
        intentRole: "quarantined",
        backoffUntil: new Date(NOW.getTime() + 60_000).toISOString()
      }),
      buildNode({ hash: "n2xxxxxx", sub2apiProxyId: 2 })
    ];
    const accounts = [buildAccount({ id: 10, proxy_id: 1 })];

    const result = reconcile({
      now: NOW,
      spec: defaultOrchestrationSpec,
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX
    });

    // 退避节点上的账号不应该出现在 planned changes 里（因为 quarantined ≠ dead；只有 evicted 才硬迁）
    const moved = result.plannedChanges.find((c) => c.accountId === 10);
    expect(moved).toBeUndefined();
  });

  it("evicted proxy's accounts get rebind_dead to a serving node", () => {
    const proxies = [buildProxy({ id: 1 }), buildProxy({ id: 2 })];
    const localNodes = [
      buildNode({ hash: "n1xxxxxx", sub2apiProxyId: 1, intentRole: "evicted" }),
      buildNode({ hash: "n2xxxxxx", sub2apiProxyId: 2 })
    ];
    const accounts = [buildAccount({ id: 10, proxy_id: 1 })];

    const result = reconcile({
      now: NOW,
      spec: defaultOrchestrationSpec,
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX
    });

    const moved = result.plannedChanges.find((c) => c.accountId === 10);
    expect(moved?.kind).toBe("rebind_dead");
    expect(moved?.toProxyId).toBe(2);
  });

  it("用户手动 retired lifecycle 的节点 → role=evicted，账号触发 rebind_dead（P5-Z 修复）", () => {
    const proxies = [buildProxy({ id: 1 }), buildProxy({ id: 2 })];
    const localNodes = [
      // 关键：intent_role 是 serving（没被 reconcile 改过）但 lifecycle=retired（用户手动设的）
      buildNode({ hash: "n1xxxxxx", sub2apiProxyId: 1, intentRole: "serving", lifecycleStatus: "retired" }),
      buildNode({ hash: "n2xxxxxx", sub2apiProxyId: 2, intentRole: "serving" })
    ];
    const accounts = [buildAccount({ id: 10, proxy_id: 1 })];

    const result = reconcile({
      now: NOW,
      spec: defaultOrchestrationSpec,
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX
    });

    // 节点角色应该被强制 evicted
    const retiredIntent = result.nodeIntents.find((i) => i.hash === "n1xxxxxx");
    expect(retiredIntent?.intentRole).toBe("evicted");
    expect(retiredIntent?.nextAction).toContain("已退役");

    // 账号应该 rebind 到节点 2
    const moved = result.plannedChanges.find((c) => c.accountId === 10);
    expect(moved?.kind).toBe("rebind_dead");
    expect(moved?.toProxyId).toBe(2);
  });

  it("lifecycle=draining 的节点同样强制 evicted（账号排空中）", () => {
    const proxies = [buildProxy({ id: 1 }), buildProxy({ id: 2 })];
    const localNodes = [
      buildNode({ hash: "n1xxxxxx", sub2apiProxyId: 1, intentRole: "serving", lifecycleStatus: "draining" }),
      buildNode({ hash: "n2xxxxxx", sub2apiProxyId: 2, intentRole: "serving" })
    ];
    const accounts = [buildAccount({ id: 10, proxy_id: 1 })];

    const result = reconcile({
      now: NOW,
      spec: defaultOrchestrationSpec,
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX
    });

    expect(result.nodeIntents.find((i) => i.hash === "n1xxxxxx")?.intentRole).toBe("evicted");
    expect(result.plannedChanges.find((c) => c.accountId === 10)?.kind).toBe("rebind_dead");
  });

  it("用户暂停 disabled 节点 → role=paused：账号留原地不迁、不接新账号（P5-AA）", () => {
    const proxies = [buildProxy({ id: 1 }), buildProxy({ id: 2 })];
    const localNodes = [
      // 1 号节点用户暂停
      buildNode({ hash: "n1xxxxxx", sub2apiProxyId: 1, intentRole: "serving", lifecycleStatus: "disabled" }),
      buildNode({ hash: "n2xxxxxx", sub2apiProxyId: 2, intentRole: "serving" })
    ];
    const accounts = [
      buildAccount({ id: 10, proxy_id: 1 }), // 已绑暂停节点
      buildAccount({ id: 20, proxy_id: null }) // 未绑，应该绑到 2 号（serving）
    ];

    const result = reconcile({
      now: NOW,
      spec: defaultOrchestrationSpec,
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX
    });

    // 暂停节点角色 = paused
    const pausedIntent = result.nodeIntents.find((i) => i.hash === "n1xxxxxx");
    expect(pausedIntent?.intentRole).toBe("paused");
    expect(pausedIntent?.nextAction).toContain("已锁定");

    // 已绑账号 10 不应该被迁走
    expect(result.plannedChanges.find((c) => c.accountId === 10)).toBeUndefined();

    // 未绑账号 20 应该绑到节点 2 (serving)，不会绑到暂停的节点 1
    const newBind = result.plannedChanges.find((c) => c.accountId === 20);
    expect(newBind?.kind).toBe("bind_missing");
    expect(newBind?.toProxyId).toBe(2);
  });

  it("cooling_down 节点 → role=evicted，账号触发 rebind_dead（P5-AD）", () => {
    // 区别于 disabled（账号留原地）：cooling_down 语义是"节点有问题需要下线"，
    // 跟 retired/draining 一样应该触发账号迁出。
    const proxies = [buildProxy({ id: 1 }), buildProxy({ id: 2 })];
    const localNodes = [
      buildNode({ hash: "n1xxxxxx", sub2apiProxyId: 1, intentRole: "serving", lifecycleStatus: "cooling_down" }),
      buildNode({ hash: "n2xxxxxx", sub2apiProxyId: 2, intentRole: "serving" })
    ];
    const accounts = [buildAccount({ id: 10, proxy_id: 1 })];

    const result = reconcile({
      now: NOW,
      spec: defaultOrchestrationSpec,
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX
    });

    expect(result.nodeIntents.find((i) => i.hash === "n1xxxxxx")?.intentRole).toBe("evicted");
    expect(result.plannedChanges.find((c) => c.accountId === 10)?.kind).toBe("rebind_dead");
  });

  it("failed/candidate 矛盾节点不得继续 serving，遗留账号必须迁出", () => {
    const proxies = [buildProxy({ id: 1 }), buildProxy({ id: 2 })];
    const broken = buildNode({
      hash: "n1xxxxxx",
      sub2apiProxyId: 1,
      intentRole: "serving",
      lifecycleStatus: "candidate",
      status: "failed",
      schedulable: false
    });
    const healthy = buildNode({ hash: "n2xxxxxx", sub2apiProxyId: 2 });
    const result = reconcile({
      now: NOW,
      spec: defaultOrchestrationSpec,
      localNodes: [broken, healthy],
      remoteProxies: proxies,
      remoteAccounts: [buildAccount({ id: 10, proxy_id: 1 })],
      managedProxyPrefix: PREFIX
    });

    expect(result.nodeIntents.find((i) => i.hash === broken.hash)?.intentRole).toBe("evicted");
    expect(result.plannedChanges.find((c) => c.accountId === 10)?.kind).toBe("rebind_dead");
    expect(result.plannedChanges.find((c) => c.accountId === 10)?.toProxyId).toBe(2);
  });
});

describe("reconcile health state machine", () => {
  it("本地 listener 消失时立即 evict 并迁出账号，不等待普通 backoff", () => {
    const proxies = [buildProxy({ id: 1 }), buildProxy({ id: 2 })];
    const localNodes = [
      buildNode({ hash: "n1xxxxxx", sub2apiProxyId: 1, intentRole: "serving" }),
      buildNode({ hash: "n2xxxxxx", sub2apiProxyId: 2, intentRole: "serving" })
    ];
    const result = reconcile({
      now: NOW,
      spec: defaultOrchestrationSpec,
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: [buildAccount({ id: 100, proxy_id: 1 })],
      managedProxyPrefix: PREFIX,
      healthSignals: new Map([[1, { errorsInWindow: 5, localListenerDown: true }]])
    });

    expect(result.nodeIntents.find((n) => n.proxyId === 1)?.intentRole).toBe("evicted");
    expect(result.nodeIntents.find((n) => n.proxyId === 1)?.nextAction).toContain("listener");
    expect(result.plannedChanges.find((c) => c.accountId === 100)?.kind).toBe("rebind_dead");
  });

  it("serving node with errors over budget enters quarantined + records backoff", () => {
    const proxies = [buildProxy({ id: 1 }), buildProxy({ id: 2 })];
    const localNodes = [
      buildNode({ hash: "n1xxxxxx", sub2apiProxyId: 1, intentRole: "serving" }),
      buildNode({ hash: "n2xxxxxx", sub2apiProxyId: 2, intentRole: "serving" })
    ];
    const accounts = [buildAccount({ id: 100, proxy_id: 1 })];
    const healthSignals = new Map([[1, { errorsInWindow: 8 }]]); // 8 ≥ 5 (default budget)
    const result = reconcile({
      now: NOW,
      spec: defaultOrchestrationSpec,
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX,
      healthSignals
    });
    const node1 = result.nodeIntents.find((n) => n.proxyId === 1);
    expect(node1?.intentRole).toBe("quarantined");
    expect(node1?.backoffAttempts).toBe(1);
    expect(node1?.backoffUntil).not.toBeNull();
    expect(new Date(node1!.backoffUntil!).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("quarantined node with active backoff stays put even with new signal", () => {
    const proxies = [buildProxy({ id: 1 })];
    const localNodes = [
      buildNode({
        hash: "n1xxxxxx",
        sub2apiProxyId: 1,
        intentRole: "quarantined",
        backoffUntil: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
        backoffAttempts: 1
      })
    ];
    const accounts = [buildAccount({ id: 100, proxy_id: 1 })];
    const healthSignals = new Map([[1, { errorsInWindow: 25 }]]); // 大量错误也无所谓
    const result = reconcile({
      now: NOW,
      spec: defaultOrchestrationSpec,
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX,
      healthSignals
    });
    const node1 = result.nodeIntents.find((n) => n.proxyId === 1);
    expect(node1?.intentRole).toBe("quarantined");
    expect(node1?.backoffAttempts).toBe(1); // 不变
  });

  it("quarantined node with expired backoff returns to serving when no new errors", () => {
    const proxies = [buildProxy({ id: 1 })];
    const localNodes = [
      buildNode({
        hash: "n1xxxxxx",
        sub2apiProxyId: 1,
        intentRole: "quarantined",
        backoffUntil: new Date(NOW.getTime() - 1_000).toISOString(),
        backoffAttempts: 2
      })
    ];
    const accounts = [buildAccount({ id: 100, proxy_id: 1 })];
    const healthSignals = new Map([[1, { errorsInWindow: 0 }]]);
    const result = reconcile({
      now: NOW,
      spec: defaultOrchestrationSpec,
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX,
      healthSignals
    });
    const node1 = result.nodeIntents.find((n) => n.proxyId === 1);
    expect(node1?.intentRole).toBe("serving");
    expect(node1?.backoffUntil).toBeNull();
    expect(node1?.healthScore).toBe(100);
  });

  it("evicted when consecutive backoff attempts exceed evictAfterBackoffs", () => {
    const proxies = [buildProxy({ id: 1 }), buildProxy({ id: 2 })];
    const localNodes = [
      buildNode({
        hash: "n1xxxxxx",
        sub2apiProxyId: 1,
        intentRole: "quarantined",
        backoffUntil: new Date(NOW.getTime() - 1_000).toISOString(),
        backoffAttempts: 5
      }),
      buildNode({ hash: "n2xxxxxx", sub2apiProxyId: 2, intentRole: "serving" })
    ];
    const accounts = [buildAccount({ id: 100, proxy_id: 1 })];
    const healthSignals = new Map([[1, { errorsInWindow: 12 }]]);
    const result = reconcile({
      now: NOW,
      spec: defaultOrchestrationSpec,
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX,
      healthSignals
    });
    const node1 = result.nodeIntents.find((n) => n.proxyId === 1);
    expect(node1?.intentRole).toBe("evicted");
    expect(node1?.backoffAttempts).toBe(6);
    const moved = result.plannedChanges.find((c) => c.accountId === 100);
    expect(moved?.kind).toBe("rebind_dead");
    expect(moved?.toProxyId).toBe(2);
  });

  it("errors below budget do NOT trigger backoff", () => {
    const proxies = [buildProxy({ id: 1 }), buildProxy({ id: 2 })];
    const localNodes = [
      buildNode({ hash: "n1xxxxxx", sub2apiProxyId: 1, intentRole: "serving" }),
      buildNode({ hash: "n2xxxxxx", sub2apiProxyId: 2, intentRole: "serving" })
    ];
    const accounts = [buildAccount({ id: 100, proxy_id: 1 })];
    const healthSignals = new Map([[1, { errorsInWindow: 3 }]]); // 3 < 5
    const result = reconcile({
      now: NOW,
      spec: defaultOrchestrationSpec,
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX,
      healthSignals
    });
    const node1 = result.nodeIntents.find((n) => n.proxyId === 1);
    expect(node1?.intentRole).toBe("serving");
    expect(node1?.backoffAttempts).toBe(0);
    expect(node1?.healthScore).toBe(85); // 100 - 3*5
  });
});

describe("rendezvous hashing (HRW) drift", () => {
  // 用 reconcile 在两种节点配置下计算账号目标，比较漂移率。
  // HRW 的数学性质：N→N-1 时漂移比例 ≈ 1/N。
  function bindMissingTargets(strategy: "stable-hash" | "rendezvous-hash", proxyIds: number[]): Map<number, number> {
    const proxies = proxyIds.map((id) => buildProxy({ id }));
    const localNodes = proxyIds.map((id) => buildNode({ hash: `n${id}xxxxxx`, sub2apiProxyId: id }));
    const accounts = Array.from({ length: 1000 }, (_, i) => buildAccount({ id: 1000 + i, proxy_id: null }));
    const spec = specWith({
      stickiness: { strategy, rebalanceTriggerPercent: 15, perTickMigrationCap: 9999 },
      graceBatchPercent: 100,
      graceBatchAbs: 99999
    });
    const result = reconcile({
      now: NOW,
      spec,
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX
    });
    const out = new Map<number, number>();
    for (const change of result.plannedChanges) {
      if (change.kind === "bind_missing") out.set(change.accountId, change.toProxyId);
    }
    return out;
  }

  it("removing one node from a 5-node HRW pool drifts ~1/5 accounts (vs ~4/5 with stable-hash)", () => {
    const fullPool = [1, 2, 3, 4, 5];
    const shrunkPool = [1, 2, 3, 4]; // 删 #5

    // HRW
    const hrwBefore = bindMissingTargets("rendezvous-hash", fullPool);
    const hrwAfter = bindMissingTargets("rendezvous-hash", shrunkPool);
    let hrwDrifted = 0;
    let hrwOnRemoved = 0; // 原来在 #5 的账号，必然漂移
    for (const [accountId, before] of hrwBefore) {
      if (before === 5) hrwOnRemoved += 1;
      const after = hrwAfter.get(accountId);
      if (after !== undefined && after !== before) hrwDrifted += 1;
    }
    const hrwDriftRate = hrwDrifted / hrwBefore.size;

    // stable-hash
    const stableBefore = bindMissingTargets("stable-hash", fullPool);
    const stableAfter = bindMissingTargets("stable-hash", shrunkPool);
    let stableDrifted = 0;
    for (const [accountId, before] of stableBefore) {
      const after = stableAfter.get(accountId);
      if (after !== undefined && after !== before) stableDrifted += 1;
    }
    const stableDriftRate = stableDrifted / stableBefore.size;

    // HRW: 漂移率 ≈ 1/5 = 0.2，等于原来在 #5 的账号比例
    expect(hrwDriftRate).toBeGreaterThan(0.15);
    expect(hrwDriftRate).toBeLessThan(0.25);
    expect(hrwDrifted).toBe(hrwOnRemoved); // 漂移的恰好就是原本在 #5 的账号

    // stable-hash: 因为 % length 变化，几乎所有账号 % 4 ≠ % 5 → 大规模漂移
    expect(stableDriftRate).toBeGreaterThan(0.6);

    // HRW 优势 ≥ 3x
    expect(hrwDriftRate * 3).toBeLessThan(stableDriftRate);
  });
});

describe("validateIntakeAgainstSpec", () => {
  it("returns null when proxy is plain (not managed, not protected)", () => {
    const proxies = [buildProxy({ id: 50, name: "handoff" })];
    const spec = specWith({ intake: { proxyId: 50, bypassGraceBatch: true } });
    expect(validateIntakeAgainstSpec(spec, proxies, PREFIX)).toBeNull();
  });

  it("rejects managed proxy as intake", () => {
    const proxies = [buildProxy({ id: 50, name: "MH-hive-handoff" })];
    const spec = specWith({ intake: { proxyId: 50, bypassGraceBatch: true } });
    expect(validateIntakeAgainstSpec(spec, proxies, PREFIX)).toMatch(/托管/);
  });

  it("rejects protected proxy as intake", () => {
    const proxies = [buildProxy({ id: 50, name: "WRT-home" })];
    const spec = specWith({
      intake: { proxyId: 50, bypassGraceBatch: true },
      protectedRule: {
        proxyIds: [],
        nameIncludes: "WRT",
        hostIncludes: "",
        countryIncludes: "",
        regionIncludes: "",
        status: ""
      }
    });
    expect(validateIntakeAgainstSpec(spec, proxies, PREFIX)).toMatch(/保护/);
  });

  it("rejects unknown proxy id", () => {
    const proxies: Sub2ApiProxyRecord[] = [];
    const spec = specWith({ intake: { proxyId: 50, bypassGraceBatch: true } });
    expect(validateIntakeAgainstSpec(spec, proxies, PREFIX)).toMatch(/不存在/);
  });
});
