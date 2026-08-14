import { describe, expect, it } from "vitest";
import type { ProxyHealthSignal } from "@mihomo-hive/core";
import { aggregateUpstreamErrorsIntoSignals, isNodeSideError, mergeProbeIntoSignals } from "./orchestrator.js";

describe("isNodeSideError 健康信号过滤（P5-V）", () => {
  describe("算节点的锅（计入 errorsInWindow）", () => {
    it.each<[number | null | undefined, string]>([
      [null, "EOF / 无 status"],
      [undefined, "缺字段"],
      [0, "连接断开"],
      [408, "请求超时"],
      [500, "上游 5xx"],
      [502, "OpenAI 自身 502 也归节点 — 不同地区路由可能避开"],
      [503, "上游 service unavailable"],
      [504, "上游 gateway timeout"],
      [522, "Cloudflare 类 5xx"]
    ])("status_code=%s (%s) → 算", (status_code) => {
      expect(isNodeSideError({ status_code })).toBe(true);
    });
  });

  describe("不算节点的锅（账号 / 客户端侧问题）", () => {
    it.each<[number, string]>([
      [400, "请求参数错（客户端 bug）"],
      [401, "OAuth token 失效（账号）"],
      [403, "权限拒绝（账号）"],
      [404, "路径错（客户端 bug）"],
      [429, "配额耗尽（账号）"]
    ])("status_code=%s (%s) → 跳过", (status_code) => {
      expect(isNodeSideError({ status_code })).toBe(false);
    });
  });

  describe("边界", () => {
    it("status_code 是字符串等异常类型 → 算（schema 兼容性）", () => {
      expect(isNodeSideError({ status_code: "weird" as unknown as number })).toBe(true);
    });
    it("204 这种 2xx 不在白名单也不在黑名单 → 不算（不是错误就不该出现，但偏稳）", () => {
      // 实际上 listUpstreamErrors 不会返回 2xx，但函数对未知 code 默认偏保守不算
      expect(isNodeSideError({ status_code: 204 })).toBe(false);
    });
    it("3xx 也不算节点（重定向不是错误）", () => {
      expect(isNodeSideError({ status_code: 301 })).toBe(false);
    });
  });
});

describe("aggregateUpstreamErrorsIntoSignals 同账号 cap（P5-AC）", () => {
  const CAP = 5;
  const accountToProxy = new Map([
    [100, 1], // account 100 绑 proxy 1
    [101, 1], // account 101 绑 proxy 1
    [200, 2]  // account 200 绑 proxy 2
  ]);

  it("单账号狂错（50 次 502）→ cap 在 5（避免一帧 evicted）", () => {
    const errors = Array.from({ length: 50 }, () => ({ account_id: 100, status_code: 502 }));
    const signals = new Map<number, ProxyHealthSignal>();
    aggregateUpstreamErrorsIntoSignals(signals, errors, accountToProxy, CAP);
    expect(signals.get(1)?.errorsInWindow).toBe(5);
  });

  it("两个账号各错 5 次（同一 proxy）→ 累积 10（多账号无 cap）", () => {
    const errors = [
      ...Array.from({ length: 5 }, () => ({ account_id: 100, status_code: 502 })),
      ...Array.from({ length: 5 }, () => ({ account_id: 101, status_code: 502 }))
    ];
    const signals = new Map<number, ProxyHealthSignal>();
    aggregateUpstreamErrorsIntoSignals(signals, errors, accountToProxy, CAP);
    expect(signals.get(1)?.errorsInWindow).toBe(10);
  });

  it("用户实测场景：1 个账号 11 个 502 → cap 在 5（修复无变更 bug）", () => {
    // 用户 P5-AC 之前：完全去重 → errors=1 < errorBudget=5 → 永远不触发
    // 修复后：cap=5 → errors=5 = errorBudget → 触发 quarantined
    const errors = Array.from({ length: 11 }, () => ({ account_id: 369, status_code: 502 }));
    const signals = new Map<number, ProxyHealthSignal>();
    const localAccountToProxy = new Map([[369, 42]]);
    aggregateUpstreamErrorsIntoSignals(signals, errors, localAccountToProxy, CAP);
    expect(signals.get(42)?.errorsInWindow).toBe(5);
  });

  it("不同 proxy 各自独立计数", () => {
    const errors = [
      ...Array.from({ length: 5 }, () => ({ account_id: 100, status_code: 502 })),
      ...Array.from({ length: 5 }, () => ({ account_id: 200, status_code: 502 }))
    ];
    const signals = new Map<number, ProxyHealthSignal>();
    aggregateUpstreamErrorsIntoSignals(signals, errors, accountToProxy, CAP);
    expect(signals.get(1)?.errorsInWindow).toBe(5);
    expect(signals.get(2)?.errorsInWindow).toBe(5);
  });

  it("非节点侧错误（401/429/400）不计入", () => {
    const errors = [
      { account_id: 100, status_code: 401 },
      { account_id: 100, status_code: 429 },
      { account_id: 100, status_code: 400 },
      { account_id: 100, status_code: 502 } // 这条才算
    ];
    const signals = new Map<number, ProxyHealthSignal>();
    aggregateUpstreamErrorsIntoSignals(signals, errors, accountToProxy, CAP);
    expect(signals.get(1)?.errorsInWindow).toBe(1);
  });

  it("缺 account_id 的错误跳过", () => {
    const errors = [
      { account_id: null, status_code: 502 },
      { account_id: undefined, status_code: 502 },
      { account_id: 100, status_code: 502 }
    ];
    const signals = new Map<number, ProxyHealthSignal>();
    aggregateUpstreamErrorsIntoSignals(signals, errors, accountToProxy, CAP);
    expect(signals.get(1)?.errorsInWindow).toBe(1);
  });

  it("account 没绑 proxy → 跳过", () => {
    const errors = [{ account_id: 999, status_code: 502 }]; // 999 不在 accountToProxy
    const signals = new Map<number, ProxyHealthSignal>();
    aggregateUpstreamErrorsIntoSignals(signals, errors, accountToProxy, CAP);
    expect(signals.size).toBe(0);
  });
});

describe("mergeProbeIntoSignals 主动探测信号合并（P5-AB）", () => {
  const NOW = 1_700_000_000_000;
  const WINDOW_MS = 5 * 60 * 1000;
  const POLICY = { enabled: true, failureCountsAsErrors: 5 };

  it("policy.enabled=false → 不改 signals", () => {
    const signals = new Map<number, ProxyHealthSignal>([[1, { errorsInWindow: 2 }]]);
    const probes = new Map([[1, { at: NOW, ok: false, detail: "timeout" }]]);
    mergeProbeIntoSignals(signals, probes, { enabled: false, failureCountsAsErrors: 5 }, WINDOW_MS, NOW);
    expect(signals.get(1)?.errorsInWindow).toBe(2);
  });

  it("探测窗口内失败 → 加 failureCountsAsErrors 条虚拟错误", () => {
    const signals = new Map<number, ProxyHealthSignal>([[1, { errorsInWindow: 0 }]]);
    const probes = new Map([[1, { at: NOW - 60_000, ok: false, detail: "ECONNREFUSED" }]]);
    mergeProbeIntoSignals(signals, probes, POLICY, WINDOW_MS, NOW);
    expect(signals.get(1)?.errorsInWindow).toBe(5);
  });

  it("本地 listener 失败会保留立即迁移信号", () => {
    const signals = new Map<number, ProxyHealthSignal>();
    const probes = new Map([[1, { at: NOW, ok: false, detail: "ECONNREFUSED", localListenerDown: true }]]);
    mergeProbeIntoSignals(signals, probes, POLICY, WINDOW_MS, NOW);
    expect(signals.get(1)).toEqual({ errorsInWindow: 5, localListenerDown: true });
  });

  it("探测窗口内失败 + upstream-errors 已有计数 → 累加", () => {
    const signals = new Map<number, ProxyHealthSignal>([[1, { errorsInWindow: 3 }]]);
    const probes = new Map([[1, { at: NOW, ok: false, detail: "timeout" }]]);
    mergeProbeIntoSignals(signals, probes, POLICY, WINDOW_MS, NOW);
    expect(signals.get(1)?.errorsInWindow).toBe(8); // 3 + 5
  });

  it("探测成功 → 初始化 0 错误信号（覆盖盲区，让 reconcile 看到该节点）", () => {
    const signals = new Map<number, ProxyHealthSignal>();
    const probes = new Map([[1, { at: NOW, ok: true, detail: "32ms" }]]);
    mergeProbeIntoSignals(signals, probes, POLICY, WINDOW_MS, NOW);
    expect(signals.get(1)?.errorsInWindow).toBe(0);
  });

  it("过期探测（超出 windowMs）→ 忽略", () => {
    const signals = new Map<number, ProxyHealthSignal>();
    const probes = new Map([[1, { at: NOW - WINDOW_MS - 1000, ok: false, detail: "old" }]]);
    mergeProbeIntoSignals(signals, probes, POLICY, WINDOW_MS, NOW);
    expect(signals.has(1)).toBe(false);
  });

  it("多个节点：成功 / 失败 / 过期混合", () => {
    const signals = new Map<number, ProxyHealthSignal>();
    const probes = new Map([
      [1, { at: NOW, ok: false, detail: "timeout" }],
      [2, { at: NOW - 30_000, ok: true, detail: "12ms" }],
      [3, { at: NOW - WINDOW_MS - 5000, ok: false, detail: "old" }]
    ]);
    mergeProbeIntoSignals(signals, probes, POLICY, WINDOW_MS, NOW);
    expect(signals.get(1)?.errorsInWindow).toBe(5);
    expect(signals.get(2)?.errorsInWindow).toBe(0);
    expect(signals.has(3)).toBe(false);
  });
});
