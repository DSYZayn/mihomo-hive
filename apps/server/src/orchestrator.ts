import { randomUUID } from "node:crypto";
import {
  buildSubscriptionImportPreview,
  createSub2ApiClient,
  filterPreviewImportableNodes,
  filteredExistingNodeHashes,
  localProbeHost,
  mapLocalNodesToSub2ApiProxies,
  mapWithConcurrency,
  measureProxyTcpLatency,
  reconcile,
  resolveProxyTestTargets,
  testProxyTarget,
  type ProxyHealthSignal,
  type ReconcileSkippedReason,
  type Sub2ApiClient
} from "@mihomo-hive/core";
import { exportSub2Api as buildSub2ApiExport } from "@mihomo-hive/exporters";
import { HiveRepository } from "@mihomo-hive/db";
import {
  reconcileObservedSummarySchema,
  reconcileTickSchema,
  sub2ApiAccountFiltersSchema,
  type OrchestrationSpec,
  type ProxyNode,
  type ReconcileNodeIntent,
  type ReconcileTick,
  type RuntimeConfig,
  type Sub2ApiAccountRecord
} from "@mihomo-hive/schemas";

// 关闭 idempotent 调度的安全句柄。
export interface ReconcileSchedulerHandle {
  triggerNow: () => Promise<ReconcileTick>;
  stop: () => void;
}

export interface NodeMaintenanceRun {
  refreshedSubscriptions: number;
  checkedNodes: number;
  passedNodes: number;
  failedNodes: number;
  pushedNodes: number;
  mappedNodes: number;
}

/**
 * 精简版后台维护器：只负责订阅幂等刷新、节点验活和 Sub2API 代理同步。
 * 它绝不会读取账号列表，也不会调用 bulk-update，因此不会改变任何账号的出口绑定。
 */
export function startNodeMaintenanceScheduler(input: {
  repo: HiveRepository;
  config: RuntimeConfig;
}): { triggerNow: () => Promise<NodeMaintenanceRun>; stop: () => void } {
  const { repo, config } = input;
  let stopped = false;
  let inFlight = false;
  let timer: NodeJS.Timeout | undefined;
  let initialTimer: NodeJS.Timeout | undefined;
  let lastSubscriptionRefreshAt = 0;

  async function run(): Promise<NodeMaintenanceRun> {
    if (inFlight) {
      return { refreshedSubscriptions: 0, checkedNodes: 0, passedNodes: 0, failedNodes: 0, pushedNodes: 0, mappedNodes: 0 };
    }
    inFlight = true;
    try {
      // 进程启动后先把旧版本留下的重复节点合并，即使自动订阅刷新被关闭也能完成一次迁移。
      repo.deduplicateNodesByIdentity();
      const spec = repo.getOrchestrationSpec();
      let refreshedSubscriptions = 0;
      const fetchInterval = Math.max(60_000, spec.supply.fetchIntervalMs);
      if (spec.supply.autoFetchSubscriptions && spec.supply.fetchIntervalMs > 0 && Date.now() - lastSubscriptionRefreshAt >= fetchInterval) {
        refreshedSubscriptions = await refreshSubscriptions(repo);
        lastSubscriptionRefreshAt = Date.now();
      }

      const health = await checkAndPersistNodeHealth(repo, config);
      const pushed = await pushHealthyNodes(repo, config);
      return { refreshedSubscriptions, ...health, ...pushed };
    } finally {
      inFlight = false;
    }
  }

  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void run().finally(scheduleNext);
    }, 60_000);
    timer.unref?.();
  }

  // 等待 server 完成 Mihomo auto-boot，避免启动窗口把所有 listener 误判为失败。
  initialTimer = setTimeout(() => {
    void run().finally(scheduleNext);
  }, 15_000);
  initialTimer.unref?.();
  return {
    triggerNow: run,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (initialTimer) clearTimeout(initialTimer);
    }
  };
}

/**
 * 启动兼容性的只读 reconcile 调度器（旧 API 保留）：
 *  - 周期触发（spec.reconcileIntervalMs）
 *  - 不再执行任何账号 proxy_id 写入，仅记录观察/计划结果
 *  - 单实例锁，避免并发 tick 互踩
 *  - 每个 tick 持久化到 reconcile_ticks
 */
export function startReconcileScheduler(input: {
  repo: HiveRepository;
  config: RuntimeConfig;
}): ReconcileSchedulerHandle {
  const { repo, config } = input;
  let stopped = false;
  let inFlight = false;
  let nextTimer: NodeJS.Timeout | undefined;

  async function tick(): Promise<ReconcileTick> {
    if (inFlight) {
      // 上一次还没跑完，跳过这一拍，避免并发；返回一个 placeholder tick
      return placeholderTick({ skipped: "no_change" });
    }
    inFlight = true;
    const startedAt = new Date();
    try {
      const spec = repo.getOrchestrationSpec();
      const connection = repo.getSub2ApiConnection();

      if (!connection) {
        const tick = persistTick({
          startedAt,
          finishedAt: new Date(),
          enabled: spec.enabled,
          plannedTotal: 0,
          appliedTotal: 0,
          skippedReason: "no_change",
          observedSummary: emptyObservedSummary(),
          nodeIntents: [],
          plannedChanges: [],
          appliedChanges: []
        });
        return tick;
      }

      const client: Sub2ApiClient = createSub2ApiClient(connection);
      const [proxies, accounts] = await Promise.all([
        client.listAllProxies(),
        client.listAllAccounts(sub2ApiAccountFiltersSchema.parse({ status: "" }))
      ]);
      const healthSignals = await fetchHealthSignals(client, accounts, spec).catch((err) => {
        console.warn("upstream-errors fetch failed; reconcile will proceed without health signals:", err);
        return new Map<number, ProxyHealthSignal>();
      });
      const localNodes = repo.listNodes();

      const result = reconcile({
        now: startedAt,
        spec,
        localNodes,
        remoteProxies: proxies,
        remoteAccounts: accounts,
        managedProxyPrefix: connection.managedProxyPrefix,
        healthSignals
      });

      // 旧版账号调和器仍保留用于只读审计，但绝不写入账号 proxy_id。
      // 账号出口由 Sub2API 现状保持不变，节点维护器负责验活和幂等推送。
      const executedTotal = 0;
      const errorMessage = result.appliedChanges.length > 0 ? "账号代理自动迁移已禁用" : undefined;
      const executedChanges: typeof result.appliedChanges = [];

      // 把 nodeIntents 写回本地节点（更新 intent_role / backoff / health_score）
      writeBackNodeIntents(repo, result.nodeIntents, localNodes);
      // 退役计时：长期 evicted 节点 → lifecycleStatus = retired
      retireOldEvicted(repo, spec, startedAt);
      // 每 24h 清理一次过老 tick，避免表无限膨胀
      maybePruneTicks(repo, startedAt);

      const tickResult: ReconcileSkippedReason = errorMessage
        ? "applied" // 即便错也算 applied（部分），让 errorMessage 解释
        : result.skippedReason;

      return persistTick({
        startedAt,
        finishedAt: new Date(),
        enabled: spec.enabled,
        plannedTotal: result.plannedChanges.length,
        appliedTotal: executedTotal,
        skippedReason: errorMessage ? "error" : tickResult,
        observedSummary: result.observedSummary,
        nodeIntents: result.nodeIntents,
        plannedChanges: result.plannedChanges,
        appliedChanges: executedChanges,
        ...(errorMessage ? { errorMessage } : {})
      });
    } catch (err) {
      // Sub2API listAll / 任意上游异常 → 写错误 tick，不挂调度器
      const message = err instanceof Error ? err.message : "未知错误";
      return persistTick({
        startedAt,
        finishedAt: new Date(),
        enabled: repo.getOrchestrationSpec().enabled,
        plannedTotal: 0,
        appliedTotal: 0,
        skippedReason: "error",
        observedSummary: emptyObservedSummary(),
        nodeIntents: [],
        plannedChanges: [],
        appliedChanges: [],
        errorMessage: message
      });
    } finally {
      inFlight = false;
    }
  }

  function persistTick(input: {
    startedAt: Date;
    finishedAt: Date;
    enabled: boolean;
    plannedTotal: number;
    appliedTotal: number;
    skippedReason: string;
    observedSummary: ReconcileTick["observedSummary"];
    nodeIntents: ReconcileTick["nodeIntents"];
    plannedChanges: ReconcileTick["plannedChanges"];
    appliedChanges: ReconcileTick["appliedChanges"];
    errorMessage?: string | undefined;
  }): ReconcileTick {
    const tick: ReconcileTick = reconcileTickSchema.parse({
      id: randomUUID(),
      startedAt: input.startedAt.toISOString(),
      finishedAt: input.finishedAt.toISOString(),
      durationMs: Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime()),
      enabled: input.enabled,
      observedSummary: input.observedSummary,
      plannedTotal: input.plannedTotal,
      appliedTotal: input.appliedTotal,
      skippedReason: input.skippedReason,
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
      nodeIntents: input.nodeIntents,
      plannedChanges: input.plannedChanges,
      appliedChanges: input.appliedChanges
    });
    try {
      repo.appendReconcileTick(tick);
    } catch (err) {
      console.error("reconcile_ticks insert failed:", err);
    }
    return tick;
  }

  function placeholderTick(input: { skipped: ReconcileSkippedReason }): ReconcileTick {
    const now = new Date();
    return reconcileTickSchema.parse({
      id: randomUUID(),
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      durationMs: 0,
      enabled: repo.getOrchestrationSpec().enabled,
      observedSummary: emptyObservedSummary(),
      plannedTotal: 0,
      appliedTotal: 0,
      skippedReason: input.skipped,
      nodeIntents: [],
      plannedChanges: [],
      appliedChanges: []
    });
  }

  function scheduleNext(): void {
    if (stopped) return;
    const spec = repo.getOrchestrationSpec();
    const interval = Math.max(5_000, spec.reconcileIntervalMs);
    nextTimer = setTimeout(() => {
      void tick().finally(scheduleNext);
    }, interval);
    nextTimer.unref?.();
  }

  // 启动时立即跑一次（让首次刷新更快）
  void tick().finally(() => {
    if (!stopped) scheduleNext();
  });

  // 订阅自动刷新子循环：按 spec.supply.fetchIntervalMs（默认 6h）独立运行。
  // fetchIntervalMs=0 或 autoFetchSubscriptions=false 都视为关闭；每分钟轻量轮询 spec
  // 看是否需要恢复，让用户重新打开后能在 1 分钟内自然接上。
  let subscriptionTimer: NodeJS.Timeout | undefined;
  function scheduleSubscriptionRefresh(): void {
    if (stopped) return;
    const spec = repo.getOrchestrationSpec();
    const disabled = !spec.supply.autoFetchSubscriptions || spec.supply.fetchIntervalMs <= 0;
    if (disabled) {
      // 关闭态：轻量等待 1min 再查 spec
      subscriptionTimer = setTimeout(scheduleSubscriptionRefresh, 60_000);
      subscriptionTimer.unref?.();
      return;
    }
    const interval = Math.max(60_000, spec.supply.fetchIntervalMs);
    subscriptionTimer = setTimeout(async () => {
      try {
        await refreshSubscriptions(repo);
      } catch (err) {
        console.error("subscription refresh failed:", err);
      }
      scheduleSubscriptionRefresh();
    }, interval);
    subscriptionTimer.unref?.();
  }
  scheduleSubscriptionRefresh();

  // 主动探测 prober 子循环：兜底"长期没流量节点"的健康信号盲区
  const stopProber = startProberLoop(repo, config, () => repo.getOrchestrationSpec());

  return {
    triggerNow: () => tick(),
    stop: () => {
      stopped = true;
      if (nextTimer) clearTimeout(nextTimer);
      if (subscriptionTimer) clearTimeout(subscriptionTimer);
      stopProber();
    }
  };
}

// ──────────────────────────────────────────────────────────────────────────

function emptyObservedSummary(): ReconcileTick["observedSummary"] {
  return reconcileObservedSummarySchema.parse({
    proxiesTotal: 0,
    proxiesServing: 0,
    proxiesQuarantined: 0,
    proxiesEvicted: 0,
    proxiesProtected: 0,
    proxiesManaged: 0,
    accountsTotal: 0,
    accountsAssignable: 0,
    accountsProtected: 0,
    capacityTotal: 0,
    utilizationPercent: 0
  });
}

function writeBackNodeIntents(
  repo: HiveRepository,
  intents: ReconcileNodeIntent[],
  localNodes: ProxyNode[]
): void {
  if (intents.length === 0) return;
  const byHash = new Map(localNodes.map((node) => [node.hash, node]));
  const updates: ProxyNode[] = [];
  const nowIso = new Date().toISOString();
  for (const intent of intents) {
    const node = byHash.get(intent.hash);
    if (!node) continue;
    const changed =
      node.intentRole !== intent.intentRole ||
      (node.backoffUntil ?? null) !== (intent.backoffUntil ?? null) ||
      (node.backoffAttempts ?? 0) !== intent.backoffAttempts ||
      (node.healthScore ?? null) !== intent.healthScore;
    if (!changed) continue;
    updates.push({
      ...node,
      intentRole: intent.intentRole,
      backoffUntil: intent.backoffUntil ?? null,
      backoffAttempts: intent.backoffAttempts,
      healthScore: intent.healthScore,
      lastHealthCheck: nowIso
    });
  }
  if (updates.length > 0) repo.saveNodes(updates);
}

// ────────────────────────────────────────────────────────────────────────────────
// 主动探测（P5-AB）：兜底"长期没流量节点没信号"盲区
// ────────────────────────────────────────────────────────────────────────────────

/** 单个节点最近一次主动探测结果。进程内存，prober loop 写、fetchHealthSignals 读。 */
interface ProbeState {
  /** 最近探测时间 */
  at: number;
  /** 探测是否成功（TCP connect OK） */
  ok: boolean;
  /** 失败原因 / 延迟（仅用于日志，不参与决策） */
  detail: string;
  /** 失败发生在本地固定 listener，需要立即迁移账号。 */
  localListenerDown?: boolean;
}

/** key = sub2apiProxyId（reconcile 用这个 id 关联） */
const probeStateByProxy = new Map<number, ProbeState>();

/**
 * 跑一轮主动探测：对所有有 raw.server:port + 有 sub2apiProxyId 的节点做 L1 TCP 探测。
 * 把结果写入内存 probeStateByProxy 供下次 reconcile 合并到 healthSignals。
 */
async function runActiveProbeRound(
  repo: HiveRepository,
  config: RuntimeConfig,
  spec: OrchestrationSpec
): Promise<void> {
  const policy = spec.health.activeProbe;
  if (!policy.enabled) return;
  const nodes = repo.listNodes().filter((n) => {
    if (!n.sub2apiProxyId) return false;
    if (!n.assignedPort) return false;
    if (n.kind !== "chain" && (typeof n.raw?.server !== "string" || typeof n.raw?.port !== "number")) return false;
    const lc = n.lifecycleStatus ?? "candidate";
    // 所有仍关联 Sub2API 的非终态节点都要测，包括历史不一致的 candidate。
    return lc !== "retired" && lc !== "deleted";
  });
  if (nodes.length === 0) return;

  await mapWithConcurrency(nodes, policy.concurrency, async (node) => {
    const listenerHost = localProbeHost(config.listenHost);
    let listenerResult = await measureProxyTcpLatency({
      host: listenerHost,
      port: Number(node.assignedPort),
      timeoutMs: Math.min(policy.timeoutMs, 2_000)
    });
    // server 启动时 scheduler 略早于 Mihomo auto-boot，给 listener 一次短暂重试，
    // 避免把正常启动窗口误记为故障并保留整个探测周期。
    if (listenerResult.error !== null) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      listenerResult = await measureProxyTcpLatency({
        host: listenerHost,
        port: Number(node.assignedPort),
        timeoutMs: Math.min(policy.timeoutMs, 2_000)
      });
    }
    if (listenerResult.error !== null) {
      probeStateByProxy.set(node.sub2apiProxyId!, {
        at: Date.now(),
        ok: false,
        detail: `local_listener: ${listenerResult.error}`,
        localListenerDown: true
      });
      return;
    }

    if (node.kind === "chain") {
      const target = resolveProxyTestTargets(["openai"])[0]!;
      const chainResult = await testProxyTarget({
        host: listenerHost,
        port: Number(node.assignedPort),
        target,
        timeoutMs: policy.timeoutMs
      });
      probeStateByProxy.set(node.sub2apiProxyId!, {
        at: Date.now(),
        ok: chainResult.ok,
        detail: chainResult.ok ? `chain:${chainResult.latencyMs}ms` : `chain:${chainResult.message}`,
        localListenerDown: false
      });
      return;
    }

    const host = node.raw.server as string;
    const port = node.raw.port as number;
    const probeResult = await measureProxyTcpLatency({ host, port, timeoutMs: policy.timeoutMs });
    probeStateByProxy.set(node.sub2apiProxyId!, {
      at: Date.now(),
      ok: probeResult.error === null,
      detail: probeResult.error ?? `${probeResult.latencyMs}ms`,
      localListenerDown: false
    });
  });
}

/** prober 的全局调度：fire-and-forget；进程退出自然停止。 */
function startProberLoop(
  repo: HiveRepository,
  config: RuntimeConfig,
  getSpec: () => OrchestrationSpec
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  async function tickAndSchedule(): Promise<void> {
    if (stopped) return;
    const spec = getSpec();
    const interval = Math.max(30_000, spec.health.activeProbe.intervalMs);
    try {
      await runActiveProbeRound(repo, config, spec);
    } catch (err) {
      console.warn("active probe round failed:", err);
    }
    if (stopped) return;
    timer = setTimeout(() => void tickAndSchedule(), interval);
    timer.unref?.();
  }

  // 启动后立即跑一次
  void tickAndSchedule();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * status_code 归因策略（P5-V）：
 *   • 算节点的锅：EOF / 连接断开 (0/null) + 408 超时 + 5xx (含 OpenAI 自身 5xx，
 *     因为不同地区路由的代理可能避开问题区)
 *   • 不算节点的锅：400 / 401 / 403 / 404 / 429 (客户端 / 账号配额 / OAuth 失效，
 *     跟代理网络完全无关)
 */
const ACCOUNT_SIDE_STATUS_CODES = new Set([400, 401, 403, 404, 429]);

export function isNodeSideError(error: { status_code?: number | null | undefined }): boolean {
  const code = error.status_code;
  // EOF / 无响应：强信号节点不可达
  if (code === null || code === undefined) return true;
  if (code === 0) return true;
  if (typeof code !== "number") return true;
  // 明确账号 / 客户端侧错误：排除
  if (ACCOUNT_SIDE_STATUS_CODES.has(code)) return false;
  // 408 timeout + 5xx：算节点（OpenAI 自身 5xx 也归节点，不同地区路由可能避开）
  return code === 408 || code >= 500;
}

/**
 * 把 Sub2API 上游错误日志聚合成"按 proxy 的窗口错误数"信号源（ADR 0003 阶段 B）。
 *
 * Sub2API 没有"账号总请求数"接口，所以我们用**绝对错误数**当判定信号。
 * 错误窗口长度由 spec.health.windowMs 决定，转成 listAllUpstreamErrors 的 timeRange 字符串。
 *
 * P5-V → P5-AC 演进：
 *   1. status_code 白名单 isNodeSideError：过滤掉账号侧 (400/401/403/404/429)，
 *      只让 EOF/408/5xx 这些"真节点级"错误进入计数。
 *   2. **同 (account, proxy) cap 至 errorBudgetPerWindow**：单账号最多算 N 次。
 *      P5-V 时是完全去重，但配合 (1) 的过滤后客户端侧错误已经被排除，单账号
 *      狂错就是真节点坏了的强信号，完全去重反而屏蔽了关键故障。改成 cap：
 *      单账号最多触发一次 quarantined，多账号累积无上限。
 */
async function fetchHealthSignals(
  client: Sub2ApiClient,
  accounts: Sub2ApiAccountRecord[],
  spec: OrchestrationSpec
): Promise<Map<number, ProxyHealthSignal>> {
  const timeRange = msToTimeRange(spec.health.windowMs);
  const errors = await client.listAllUpstreamErrors({ timeRange, view: "errors", phase: "upstream" });

  // 当前账号 → 当前 proxy_id 映射（用现在的视角归因，不查历史绑定）
  const accountToProxy = new Map<number, number>();
  for (const account of accounts) {
    if (account.proxy_id) accountToProxy.set(account.id, account.proxy_id);
  }

  const signals = new Map<number, ProxyHealthSignal>();
  // 先把所有当前有账号绑定的 proxy 都初始化为 0 错误（让"无错"也是有效信号）
  for (const proxyId of new Set(accountToProxy.values())) {
    signals.set(proxyId, { errorsInWindow: 0 });
  }

  aggregateUpstreamErrorsIntoSignals(signals, errors, accountToProxy, spec.health.errorBudgetPerWindow);

  // P5-AB 信号合并：把主动探测结果叠加到 upstream-errors 信号上
  mergeProbeIntoSignals(signals, probeStateByProxy, spec.health.activeProbe, spec.health.windowMs, Date.now());
  return signals;
}

/**
 * 把 Sub2API upstream-errors 列表聚合到 health signals（纯函数，方便单测）。
 *
 * 双重过滤：
 *   1. isNodeSideError：仅 EOF/408/5xx 计入，排除 400/401/403/404/429 等账号侧
 *   2. 同 (account, proxy) cap 至 perPairCap（默认 errorBudgetPerWindow）：
 *      单账号狂错最多触发一次 quarantined；多账号累积无上限
 */
export function aggregateUpstreamErrorsIntoSignals(
  signals: Map<number, ProxyHealthSignal>,
  errors: Array<{ account_id?: number | null | undefined; status_code?: number | null | undefined }>,
  accountToProxy: Map<number, number>,
  perPairCap: number
): Map<number, ProxyHealthSignal> {
  const errorsByPair = new Map<string, number>();
  for (const error of errors) {
    if (!error.account_id) continue;
    if (!isNodeSideError(error)) continue;
    const proxyId = accountToProxy.get(error.account_id);
    if (!proxyId) continue;
    const pairKey = `${error.account_id}:${proxyId}`;
    const pairCount = errorsByPair.get(pairKey) ?? 0;
    if (pairCount >= perPairCap) continue;
    errorsByPair.set(pairKey, pairCount + 1);
    const current = signals.get(proxyId) ?? { errorsInWindow: 0 };
    signals.set(proxyId, { errorsInWindow: current.errorsInWindow + 1 });
  }
  return signals;
}

/**
 * 把主动探测结果合并到 health signals（纯函数，方便单测）。
 *
 *   • 探测窗口内成功：保证该 proxy 至少有 0 错误的 signal（覆盖 upstream-errors 盲区）
 *   • 探测窗口内失败：每次失败 += failureCountsAsErrors 个虚拟错误
 *   • 过期探测（>windowMs）忽略
 */
export function mergeProbeIntoSignals(
  signals: Map<number, ProxyHealthSignal>,
  probeStates: Map<number, ProbeState>,
  policy: { enabled: boolean; failureCountsAsErrors: number },
  windowMs: number,
  now: number
): Map<number, ProxyHealthSignal> {
  if (!policy.enabled) return signals;
  const windowStart = now - windowMs;
  for (const [proxyId, state] of probeStates) {
    if (state.at < windowStart) continue;
    if (!signals.has(proxyId)) signals.set(proxyId, { errorsInWindow: 0 });
    if (state.ok) continue;
    const current = signals.get(proxyId)!;
    signals.set(proxyId, { errorsInWindow: current.errorsInWindow + policy.failureCountsAsErrors });
    if (state.localListenerDown) signals.get(proxyId)!.localListenerDown = true;
  }
  return signals;
}

function msToTimeRange(ms: number): string {
  if (ms <= 0) return "5m";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.round(ms / 3_600_000);
  return `${Math.max(1, hours)}h`;
}

// 每个 scheduler 实例独立计数；进程重启即重置（也会立刻清理一次，副作用可接受）。
let lastPruneAtMs = 0;
function maybePruneTicks(repo: HiveRepository, now: Date): void {
  const ONE_DAY = 24 * 60 * 60 * 1000;
  if (now.getTime() - lastPruneAtMs < ONE_DAY) return;
  const deleted = repo.pruneReconcileTicks(7);
  lastPruneAtMs = now.getTime();
  if (deleted > 0) {
    console.log(`pruned ${deleted} reconcile tick(s) older than 7 days`);
  }
}

/**
 * 退役计时（ADR 0003 supply.evictAfterDays）。
 *
 * intentRole=evicted 且 last_health_check（或 updatedAt 兜底）已超过 evictAfterDays 天的节点
 * → lifecycleStatus 设为 retired。Reconcile 不再考虑它们；Mihomo 渲染也排除。
 */
function retireOldEvicted(repo: HiveRepository, spec: OrchestrationSpec, now: Date): void {
  const cutoff = new Date(now.getTime() - spec.supply.evictAfterDays * 24 * 60 * 60 * 1000);
  const updates: ProxyNode[] = [];
  for (const node of repo.listNodes()) {
    if (node.intentRole !== "evicted") continue;
    if (node.lifecycleStatus === "retired" || node.lifecycleStatus === "deleted") continue;
    const reference = node.lastHealthCheck ? new Date(node.lastHealthCheck) : new Date(node.updatedAt);
    if (reference > cutoff) continue;
    updates.push({ ...node, lifecycleStatus: "retired", schedulable: false });
  }
  if (updates.length > 0) {
    repo.saveNodes(updates);
    console.log(`retired ${updates.length} evicted node(s) past ${spec.supply.evictAfterDays} days`);
  }
}

/**
 * 订阅自动刷新子循环（ADR 0003 supply policy）。
 *
 * 等价于用户手动跑 subscriptions.applyImport，但批量+无人值守：
 *   1) 遍历所有 enabled 订阅源
 *   2) fetch + parse + build preview
 *   3) upsert importable 节点（status=untested、intent=standby，待测试）
 *   4) 删除被新规则过滤命中的现有节点（deletedByFilter 路径）
 *
 * 不抛错；单个订阅失败只跳过它，其他继续。
 */
async function refreshSubscriptions(repo: HiveRepository): Promise<number> {
  const sources = repo.listSubscriptions().filter((source) => source.enabled);
  let refreshed = 0;
  for (const source of sources) {
    try {
      const content = await repo.fetchSubscriptionContent(source);
      repo.updateSubscriptionContent(source.id, content);
      const existingNodes = repo.listNodes();
      const preview = buildSubscriptionImportPreview({
        source,
        content,
        existingNodes,
        excludeKeywords: source.excludeKeywords
      });
      const importable = filterPreviewImportableNodes({
        source,
        content,
        existingNodes,
        excludeKeywords: source.excludeKeywords
      }).map((node) => ({
        ...node,
        lifecycleStatus: "candidate" as const,
        schedulable: false
      }));
      const deleteHashes = filteredExistingNodeHashes({
        source,
        content,
        existingNodes,
        excludeKeywords: source.excludeKeywords
      });
      if (deleteHashes.length > 0) repo.deleteNodes(deleteHashes);
      if (importable.length > 0) repo.upsertNodes(importable);
      refreshed += 1;
      console.log(
        `subscription auto-refresh "${source.name}": total ${preview.summary.total}, new ${preview.summary.importable - preview.summary.updates}, updated ${preview.summary.updates}, duplicateInSource ${preview.summary.duplicates}, existingOtherSource ${preview.summary.existing}, filtered ${preview.summary.filtered}, deletedByFilter ${deleteHashes.length}`
      );
    } catch (err) {
      console.warn(`subscription "${source.name}" refresh failed:`, err);
    }
  }
  const deduplicated = repo.deduplicateNodesByIdentity();
  if (deduplicated > 0) {
    console.log(`subscription auto-refresh: merged ${deduplicated} duplicate node(s)`);
  }
  return refreshed;
}

async function checkAndPersistNodeHealth(repo: HiveRepository, config: RuntimeConfig): Promise<{
  checkedNodes: number;
  passedNodes: number;
  failedNodes: number;
}> {
  const nodes = repo
    .listNodes()
    .filter((node) => Boolean(node.assignedPort))
    .filter((node) => node.lifecycleStatus !== "retired" && node.lifecycleStatus !== "deleted" && node.lifecycleStatus !== "disabled");
  if (nodes.length === 0) return { checkedNodes: 0, passedNodes: 0, failedNodes: 0 };

  const results = await mapWithConcurrency(nodes, 8, async (node) => {
    // 以本地 listener 为主：URI 订阅节点可能没有展开的 server/port 字段，
    // 但只要 Mihomo listener 可达就应视为可用候选，不因解析形式误杀。
    const listenerResult = await measureProxyTcpLatency({
      host: localProbeHost(config.listenHost),
      port: Number(node.assignedPort),
      timeoutMs: 8_000
    });
    if (listenerResult.error !== null) {
      return { node, ok: false, latencyMs: listenerResult.latencyMs, detail: `listener:${listenerResult.error}` };
    }
    const target = resolveProxyTestTargets(["openai"])[0]!;
    const upstreamResult = await testProxyTarget({
      host: localProbeHost(config.listenHost),
      port: Number(node.assignedPort),
      target,
      timeoutMs: 15_000
    });
    return {
      node,
      ok: upstreamResult.ok,
      latencyMs: listenerResult.latencyMs,
      detail: upstreamResult.ok ? `listener:${listenerResult.latencyMs}ms` : upstreamResult.message
    };
  });

  const now = new Date().toISOString();
  repo.saveNodes(
    results.map(({ node, ok, latencyMs, detail }) => ({
      ...node,
      status: ok ? "active" as const : "failed" as const,
      qualityScore: ok ? 100 : 0,
      lastTestLatencyMs: latencyMs,
      lastTestStatus: ok ? `tcp:ok:${detail}` : `tcp:failed:${detail}`,
      lastTestTargets: JSON.stringify([{ targetId: "tcp", ok, latencyMs, message: detail }]),
      lastHealthCheck: now,
      updatedAt: now
    }))
  );

  return {
    checkedNodes: results.length,
    passedNodes: results.filter((result) => result.ok).length,
    failedNodes: results.filter((result) => !result.ok).length
  };
}

async function pushHealthyNodes(repo: HiveRepository, config: RuntimeConfig): Promise<{
  pushedNodes: number;
  mappedNodes: number;
}> {
  const connection = repo.getSub2ApiConnection();
  if (!connection) return { pushedNodes: 0, mappedNodes: 0 };

  const nodes = repo.listNodes();
  const payload = buildSub2ApiExport(nodes, {
    host: config.exportHost,
    namePrefix: connection.managedProxyPrefix,
    selectedHashes: nodes
      .filter(
        (node) =>
          node.status === "active" &&
          Boolean(node.assignedPort) &&
          (node.lifecycleStatus === "schedulable" || node.schedulable === true) &&
          node.lifecycleStatus !== "retired" &&
          node.lifecycleStatus !== "deleted" &&
          node.lifecycleStatus !== "disabled"
      )
      .map((node) => node.hash)
  });
  const proxies = payload.proxies.filter((proxy) => proxy.status === "active");
  if (proxies.length === 0) return { pushedNodes: 0, mappedNodes: 0 };

  const client = createSub2ApiClient(connection);
  await client.importProxyData({ proxies });
  const liveProxies = await client.listAllProxies();
  const mappings = mapLocalNodesToSub2ApiProxies({ nodes: repo.listNodes(), proxies: liveProxies, exportHost: config.exportHost });
  repo.updateSub2ApiProxyMappings(mappings);
  return { pushedNodes: proxies.length, mappedNodes: mappings.length };
}
