/**
 * AccountFleetScheduler —— 跟现有 ReconcileScheduler 平级的账号生命周期调度器。
 *
 * P4: 只跑 observe + diagnose + plan + gate，写 account_fleet_ticks（dry-run），
 *     **不入队 account_jobs**。
 *
 * P6 会扩展为：把 gatedActions 转成 account_jobs 行入队（status=queued），
 *     由独立的 AccountJobsWorker 异步消费。
 */

import { randomUUID } from "node:crypto";
import {
  accountFleetTickSchema,
  type AccountFleetPlannedAction,
  type AccountFleetTick,
  type AccountFleetObservedSummary
} from "@mihomo-hive/schemas";
import { planAccountFleet, createSub2ApiClient } from "@mihomo-hive/core";
import { HiveRepository } from "@mihomo-hive/db";

export interface AccountFleetSchedulerHandle {
  triggerNow: () => Promise<AccountFleetTick>;
  stop: () => void;
}

export interface AccountFleetSchedulerOptions {
  repo: HiveRepository;
}

export function startAccountFleetScheduler(
  options: AccountFleetSchedulerOptions
): AccountFleetSchedulerHandle {
  const { repo } = options;
  let stopped = false;
  let inFlight = false;
  let nextTimer: NodeJS.Timeout | undefined;

  async function tick(): Promise<AccountFleetTick> {
    if (inFlight) {
      return placeholderTick();
    }
    inFlight = true;
    const startedAt = new Date();
    try {
      const spec = repo.getAccountFleetSpec();
      const connection = repo.getSub2ApiConnection();

      // 拉远端 accounts + upstream errors（如果连接已配置）。
      // 失败不阻断 tick，按 local-only 模式走 plan。
      let remoteAccounts;
      let upstreamErrorsByAccountId: Map<number, number> | undefined;
      if (connection) {
        try {
          const client = createSub2ApiClient(connection);
          remoteAccounts = await client.listAllAccounts({
            platform: "openai",
            type: "",
            status: "",
            privacyMode: "",
            group: "",
            search: ""
          });
        } catch (err) {
          console.warn("AccountFleet: failed to fetch Sub2API accounts; using local-only view:", err);
        }
        try {
          const client = createSub2ApiClient(connection);
          const windowSec = Math.max(60, Math.floor(spec.health.windowMs / 1000));
          const timeRange = windowSec >= 3600 ? "1h" : windowSec >= 600 ? "10m" : "5m";
          const errors = await client.listAllUpstreamErrors({ timeRange, view: "errors", phase: "upstream" });
          upstreamErrorsByAccountId = new Map<number, number>();
          for (const e of errors) {
            const id = (e as { account_id?: number | null }).account_id ?? null;
            if (id) {
              upstreamErrorsByAccountId.set(id, (upstreamErrorsByAccountId.get(id) ?? 0) + 1);
            }
          }
        } catch (err) {
          console.warn(
            "AccountFleet: failed to fetch upstream errors; accounts errorsInWindow stays 0:",
            err
          );
        }
      }

      // P5-AM: Sub2API 自己标 status=error 的账号（如 "Token revoked (401)"）→ 确定性
      // 需重登信号。按 externalId 收集错误原因，交给 diagnose 最高优先级判 broken，
      // 避免 has_refresh_token=true + 配额低时被误判健康。
      let remoteAuthErrorByExternalId: Map<number, string> | undefined;
      if (remoteAccounts) {
        remoteAuthErrorByExternalId = new Map<number, string>();
        for (const r of remoteAccounts) {
          if (r.status === "error") {
            remoteAuthErrorByExternalId.set(
              r.id,
              r.error_message ? `Sub2API: ${r.error_message}` : "Sub2API 标记账号异常（status=error）"
            );
          }
        }
      }

      const localAccounts = repo.listAccounts();
      const budgetState = getBudgetState(repo, spec, startedAt);

      const result = planAccountFleet({
        now: startedAt,
        spec,
        localAccounts,
        ...(remoteAccounts ? { remoteAccounts } : {}),
        ...(upstreamErrorsByAccountId ? { upstreamErrorsByAccountId } : {}),
        ...(remoteAuthErrorByExternalId ? { remoteAuthErrorByExternalId } : {}),
        budgetState
      });

      // 写回 observedAccounts（health / brokenConsecutiveTicks / errorsInWindow 等观察字段）
      for (const acc of result.observedAccounts) {
        // 如果是 sense 阶段新增的 adopted_*，需要 upsert；其它走 patch
        const existing = repo.getAccountById(acc.id);
        if (!existing) {
          repo.upsertAccount(acc);
        } else {
          repo.patchAccount(acc.id, {
            origin: acc.origin,
            intent: acc.intent,
            health: acc.health,
            email: acc.email,
            lastObservedAt: acc.lastObservedAt,
            lastUsedAt: acc.lastUsedAt,
            rateLimitedAt: acc.rateLimitedAt,
            rateLimitResetAt: acc.rateLimitResetAt,
            quota5hPercent: acc.quota5hPercent,
            quota7dPercent: acc.quota7dPercent,
            errorsInWindow: acc.errorsInWindow,
            brokenSinceTick: acc.brokenSinceTick,
            brokenConsecutiveTicks: acc.brokenConsecutiveTicks,
            // P5-AM: diagnose 给 revoked-token 账号写了 lastRecoveryError（"为什么挂"），
            // 之前 patch 漏了这个字段导致原因不落库；补上让 UI 能展示。非 revoked 账号
            // 这里携带的是其原有值（diagnose 用 {...a} 保留），不会被误清。
            lastRecoveryError: acc.lastRecoveryError,
            organizationId: acc.organizationId,
            clientId: acc.clientId
          });
        }
      }

      // P4: dry-run —— 不入队 jobs，只写 tick
      // 把 gatedActions 转 account_jobs 入队 —— 不再有 dry_run 模式开关，
      // spec.enabled / recovery.enabled / registration.enabled 默认都是 false，
      // 用户在 UI 显式打开后 plan 才会产出对应 actions。
      const triggeredJobIds: string[] = [];
      const tickId = randomUUID();
      // P5-AV：去重 —— 已有 queued/running job 的账号本 tick 不再重复入队恢复任务，
      // 避免同一账号堆积几十个 codex_login（之前死账号能囤 17 个 queued 死磕槽位）。
      const pending = repo.accountIdsWithPendingJobs();
      for (const action of result.gatedActions) {
        const isRecovery =
          action.kind === "recover_via_login" ||
          action.kind === "recover_via_register" ||
          action.kind === "register_new";
        if (isRecovery && action.accountId && pending.has(action.accountId)) {
          continue; // 该账号已有在途 job，跳过本次入队
        }
        const jobId = enqueueJobForAction(repo, action, startedAt, tickId);
        if (jobId) {
          triggeredJobIds.push(jobId);
          if (action.accountId) pending.add(action.accountId); // 防本 tick 内重复
        }
      }

      const tick = persistTick({
        id: tickId,
        startedAt,
        finishedAt: new Date(),
        enabled: spec.enabled,
        plannedTotal: result.plannedActions.length,
        appliedTotal: result.gatedActions.length,
        skippedReason: result.inferredSkippedReason,
        observed: result.observedSummary,
        plannedActions: result.plannedActions,
        appliedActions: result.gatedActions,
        triggeredJobIds
      });

      // 自维护：每 24h 清理一次过老 tick
      maybePruneTicks(repo, startedAt);

      return tick;
    } catch (err) {
      const message = err instanceof Error ? err.message : "未知错误";
      const finishedAt = new Date();
      return persistTick({
        startedAt,
        finishedAt,
        enabled: repo.getAccountFleetSpec().enabled,
        plannedTotal: 0,
        appliedTotal: 0,
        skippedReason: "error",
        observed: emptyObservedSummary(),
        plannedActions: [],
        appliedActions: [],
        triggeredJobIds: [],
        errorMessage: message
      });
    } finally {
      inFlight = false;
    }
  }

  function persistTick(input: {
    id?: string;
    startedAt: Date;
    finishedAt: Date;
    enabled: boolean;
    plannedTotal: number;
    appliedTotal: number;
    skippedReason: AccountFleetTick["skippedReason"];
    observed: AccountFleetObservedSummary;
    plannedActions: AccountFleetTick["plannedActions"];
    appliedActions: AccountFleetTick["appliedActions"];
    triggeredJobIds: string[];
    errorMessage?: string;
  }): AccountFleetTick {
    const tick = accountFleetTickSchema.parse({
      id: input.id ?? randomUUID(),
      startedAt: input.startedAt.toISOString(),
      finishedAt: input.finishedAt.toISOString(),
      durationMs: Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime()),
      enabled: input.enabled,
      skippedReason: input.skippedReason,
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
      plannedTotal: input.plannedTotal,
      appliedTotal: input.appliedTotal,
      observed: input.observed,
      plannedActions: input.plannedActions,
      appliedActions: input.appliedActions,
      triggeredJobIds: input.triggeredJobIds
    });
    try {
      repo.appendAccountFleetTick(tick);
    } catch (err) {
      console.error("account_fleet_ticks insert failed:", err);
    }
    return tick;
  }

  function placeholderTick(): AccountFleetTick {
    const now = new Date();
    return accountFleetTickSchema.parse({
      id: randomUUID(),
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      durationMs: 0,
      enabled: repo.getAccountFleetSpec().enabled,
      skippedReason: "no_change",
      plannedTotal: 0,
      appliedTotal: 0,
      observed: emptyObservedSummary(),
      plannedActions: [],
      appliedActions: [],
      triggeredJobIds: []
    });
  }

  // tick 硬超时保护:调度循环靠 tick().finally(scheduleNext) 排下一次——对 tick **抛错**健壮,
  // 但对 tick "卡住永不 settle"(如某个无超时的 Sub2API/网络调用 stall)无能为力:.finally 永不
  // 触发 → 整个编排冻死(实测午夜一次 stall 把调度器冻到天亮、自动注册全停)。这里给每次 tick
  // 套 3 分钟硬超时:超时即放弃本次(底层挂起的 promise 任其后台自然结束)、保证一定排下一轮自愈。
  async function tickGuarded(): Promise<void> {
    const TICK_TIMEOUT_MS = 3 * 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        tick().then(() => undefined),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`reconcile tick 超时(>${TICK_TIMEOUT_MS}ms),放弃本次、继续下一轮`)),
            TICK_TIMEOUT_MS
          );
          timer.unref?.();
        })
      ]);
    } catch (err) {
      console.error("AccountFleetScheduler tick 错误/超时:", err instanceof Error ? err.message : err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function scheduleNext(): void {
    if (stopped) return;
    const spec = repo.getAccountFleetSpec();
    const interval = Math.max(30_000, spec.reconcileIntervalMs);
    nextTimer = setTimeout(() => {
      void tickGuarded().finally(scheduleNext);
    }, interval);
    nextTimer.unref?.();
  }

  // 启动时立即跑一次(同样套超时保护)
  void tickGuarded().finally(() => {
    if (!stopped) scheduleNext();
  });

  return {
    triggerNow: () => tick(),
    stop: () => {
      stopped = true;
      if (nextTimer) clearTimeout(nextTimer);
    }
  };
}

// ─── helpers ─────────────────────────────────────

function emptyObservedSummary(): AccountFleetObservedSummary {
  return {
    totalAccounts: 0,
    byHealth: { healthy: 0, rate_limited: 0, quota_exhausted: 0, broken: 0, unknown: 0 },
    byOrigin: {
      hive_registered: 0,
      adopted_active: 0,
      adopted_recovered: 0,
      adopted_observing: 0,
      retired_legacy: 0
    },
    byIntent: { pending: 0, active: 0, recovering: 0, retired: 0 },
    healthyCount: 0,
    target: 0,
    targetGap: 0,
    minHealthyRatio: 0,
    emergencyMode: false,
    dailyRegistrationsUsed: 0,
    dailyRegistrationsBudget: 0,
    monthlyRegistrationsUsed: 0,
    monthlyRegistrationsBudget: 0
  };
}

function getBudgetState(
  repo: HiveRepository,
  spec: ReturnType<HiveRepository["getAccountFleetSpec"]>,
  at: Date
): {
  dailyUsed: number;
  dailyBudget: number;
  monthlyUsed: number;
  monthlyBudget: number;
} {
  const dayKey = budgetWindowKey(at, "day");
  const monthKey = budgetWindowKey(at, "month");
  const day = repo.getAccountBudget(dayKey);
  const month = repo.getAccountBudget(monthKey);
  return {
    dailyUsed: day?.registrationsUsed ?? 0,
    dailyBudget: spec.registration.dailyBudget,
    monthlyUsed: month?.registrationsUsed ?? 0,
    monthlyBudget: spec.registration.monthlyBudget
  };
}

/**
 * 把一个 PlannedAction 转成 account_jobs 行入队（apply 模式用）。
 * 返回 job.id；如果该 action 不需要入队（比如 defer / observe_usage 不映射到 jobs），返回 null。
 *
 * 注意：retire 也不入队 —— 它是本地标记，由 scheduler 自己改 intent + 配套触发
 * delete_external 或 toggle_schedulable 子动作。
 */
function enqueueJobForAction(
  repo: HiveRepository,
  action: AccountFleetPlannedAction,
  scheduledAt: Date,
  triggeredTickId: string
): string | null {
  const now = scheduledAt.toISOString();
  const id = randomUUID();
  const baseJob = {
    id,
    accountId: action.accountId,
    status: "queued" as const,
    attempt: 0,
    maxAttempts: 1,
    priority: 100,
    scheduledAt: now,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    resultJson: null,
    errorMessage: null,
    triggeredBy: "scheduler" as const,
    triggeredTickId,
    createdAt: now,
    updatedAt: now
  };
  switch (action.kind) {
    case "recover_via_login":
      repo.enqueueAccountJob({
        ...baseJob,
        kind: "codex_login",
        payloadJson: JSON.stringify({ reason: action.reason })
      });
      return id;
    case "recover_via_register":
    case "register_new":
      repo.enqueueAccountJob({
        ...baseJob,
        kind: "codex_register",
        // codex_register 平均几分钟，让它最多重试 1 次（registration 太贵不重试）
        maxAttempts: 1,
        payloadJson: JSON.stringify({ reason: action.reason })
      });
      return id;
    case "demote_to_observing":
      // 不入队 —— 直接本地改 origin
      if (action.accountId) {
        repo.patchAccount(action.accountId, { origin: "adopted_observing" });
      }
      return null;
    case "retire":
      // 直接本地标 retired；如果配置了 deleteOnRetire 还要走 delete_external
      if (action.accountId) {
        const spec = repo.getAccountFleetSpec();
        repo.patchAccount(action.accountId, { intent: "retired" });
        // P5-AV：退役同时取消该账号残留 queued 恢复 job，避免死磕（与 worker 失败
        // 退役路径一致；调度器退役路径之前漏了这步，导致退役账号仍堆着 queued）。
        repo.cancelQueuedJobsForAccount(action.accountId, "scheduler 退役");
        if (spec.retirement.deleteOnRetire && action.externalId) {
          repo.enqueueAccountJob({
            ...baseJob,
            id: randomUUID(),
            kind: "delete_sub2api",
            payloadJson: JSON.stringify({})
          });
        }
      }
      return null;
    case "delete_external":
      repo.enqueueAccountJob({
        ...baseJob,
        kind: "delete_sub2api",
        payloadJson: JSON.stringify({})
      });
      return id;
    case "toggle_schedulable":
      repo.enqueueAccountJob({
        ...baseJob,
        kind: "toggle_schedulable",
        payloadJson: JSON.stringify({ schedulable: false })
      });
      return id;
    case "observe_usage":
      repo.enqueueAccountJob({
        ...baseJob,
        kind: "observe_usage",
        payloadJson: JSON.stringify({})
      });
      return id;
    case "defer":
      return null;
    default: {
      const _exhaustive: never = action.kind;
      return _exhaustive;
    }
  }
}

export function budgetWindowKey(at: Date, kind: "day" | "month"): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, "0");
  if (kind === "month") {
    return `${y}-${m}-month`;
  }
  const d = String(at.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}-day`;
}

let lastPruneAt = 0;
function maybePruneTicks(repo: HiveRepository, now: Date): void {
  const t = now.getTime();
  if (t - lastPruneAt < 24 * 60 * 60 * 1000) return;
  lastPruneAt = t;
  try {
    repo.pruneAccountFleetTicks(7);
    repo.pruneAccountJobs(14);
  } catch (err) {
    console.warn("AccountFleet prune failed:", err);
  }
}
