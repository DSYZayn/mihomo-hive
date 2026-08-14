import { createHash } from "node:crypto";
import {
  reconcileObservedSummarySchema,
  type OrchestrationSpec,
  type ProxyNode,
  type ReconcileNodeIntent,
  type ReconcileObservedSummary,
  type ReconcilePlannedChange,
  type Sub2ApiAccountRecord,
  type Sub2ApiProxyRecord
} from "@mihomo-hive/schemas";
import { matchesProtectedProxy } from "./sub2api-assignment.js";
import { isManagedProxy } from "./sub2api-maintenance.js";

export interface ProxyHealthSignal {
  // 窗口内 Sub2API 上游错误条数（5xx / 429 / timeout 等）。
  // Sub2API 没有"总请求数"接口，所以这里用绝对错误数当主信号。
  errorsInWindow: number;
  /** 本地固定 listener 不可达；这是立即迁移信号，不走普通上游错误退避。 */
  localListenerDown?: boolean;
}

export interface ReconcileInput {
  now: Date;
  spec: OrchestrationSpec;
  localNodes: ProxyNode[];
  remoteProxies: Sub2ApiProxyRecord[];
  remoteAccounts: Sub2ApiAccountRecord[];
  managedProxyPrefix: string;
  // 健康信号（阶段 B）：按 proxy_id 聚合的滑动窗口错误统计。可选，缺省时不参与判定。
  healthSignals?: Map<number, ProxyHealthSignal>;
}

export type ReconcileSkippedReason = "paused" | "batch_capped" | "no_change" | "applied";

export interface ReconcileResult {
  observedSummary: ReconcileObservedSummary;
  nodeIntents: ReconcileNodeIntent[];
  plannedChanges: ReconcilePlannedChange[];
  appliedChanges: ReconcilePlannedChange[];
  skippedReason: ReconcileSkippedReason;
}

interface ObservedWorld {
  enabled: boolean;
  spec: OrchestrationSpec;
  nowDate: Date;
  proxies: Sub2ApiProxyRecord[];
  proxiesById: Map<number, Sub2ApiProxyRecord>;
  localByProxyId: Map<number, ProxyNode>;
  managedProxyIds: Set<number>;
  protectedProxyIds: Set<number>;
  accountsByProxyId: Map<number, Sub2ApiAccountRecord[]>;
  uniqueAccounts: Sub2ApiAccountRecord[];
  intakeProxyId: number | null;
  healthSignals: Map<number, ProxyHealthSignal>;
}

interface NodeRoleDecision {
  proxyId: number;
  proxy: Sub2ApiProxyRecord;
  localNode: ProxyNode | undefined;
  role: "serving" | "standby" | "quarantined" | "evicted" | "paused";
  currentLoad: number;
  targetLoad: number;
  nextAction: string;
  // 阶段 B 新增 — 由 decide 阶段写出，给 orchestrator 写回数据库
  backoffUntilIso: string | null;
  backoffAttempts: number;
  healthScore: number | null;
}

/**
 * 纯函数入口。五步：观测 → 判定 → 规划 → 限速 → 汇总。
 * 不做任何 I/O，方便单元测试。Scheduler / router 层去真正写远端。
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const world = observeWorld(input);
  const { decisions, roleSets } = decideNodeRoles(world);
  const planned = planChanges(world, decisions, roleSets);
  const { applied, skippedReason } = gateChanges(world, planned);

  return {
    observedSummary: summarizeObserved(world, decisions),
    nodeIntents: buildNodeIntents(world, decisions),
    plannedChanges: planned,
    appliedChanges: applied,
    skippedReason
  };
}

interface RoleSets {
  serving: Set<number>;
  quarantined: Set<number>;
  evicted: Set<number>;
  paused: Set<number>;
}

// ──────────────────────────────────────────────────────────────────────────
// Step 1 — observe

function observeWorld(input: ReconcileInput): ObservedWorld {
  const proxies = input.remoteProxies.slice().sort((a, b) => a.id - b.id);
  const proxiesById = new Map(proxies.map((proxy) => [proxy.id, proxy]));

  const localByProxyId = new Map<number, ProxyNode>();
  for (const node of input.localNodes) {
    if (node.sub2apiProxyId) localByProxyId.set(node.sub2apiProxyId, node);
  }

  const managedProxyIds = new Set(
    proxies.filter((p) => isManagedProxy(p, input.managedProxyPrefix)).map((p) => p.id)
  );
  const protectedProxyIds = new Set(
    proxies.filter((p) => matchesProtectedProxy(p, input.spec.protectedRule)).map((p) => p.id)
  );

  const accountsByProxyId = new Map<number, Sub2ApiAccountRecord[]>();
  for (const account of input.remoteAccounts) {
    if (!account.proxy_id) continue;
    const bucket = accountsByProxyId.get(account.proxy_id) ?? [];
    bucket.push(account);
    accountsByProxyId.set(account.proxy_id, bucket);
  }

  const intakeProxyId =
    input.spec.intake.proxyId && proxiesById.has(input.spec.intake.proxyId) ? input.spec.intake.proxyId : null;

  return {
    enabled: input.spec.enabled,
    spec: input.spec,
    nowDate: input.now,
    proxies,
    proxiesById,
    localByProxyId,
    managedProxyIds,
    protectedProxyIds,
    accountsByProxyId,
    uniqueAccounts: dedupeAccounts(input.remoteAccounts),
    intakeProxyId,
    healthSignals: input.healthSignals ?? new Map()
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Step 2 — decide

function decideNodeRoles(world: ObservedWorld): { decisions: NodeRoleDecision[]; roleSets: RoleSets } {
  // 估算 target：用"managed 且非保护非入站非旧 evicted"作为 serving 候选数（稳定不抖动）。
  // 节点退避不会让 target 立刻突增，下一拍 reconcile 自然收敛。
  const candidateServingCount = countCandidateServing(world);
  const assignableAccountCount = world.uniqueAccounts.filter((account) => {
    if (account.proxy_id && world.protectedProxyIds.has(account.proxy_id)) return false;
    return true;
  }).length;
  const target =
    world.spec.capacity.targetPerNode === "auto"
      ? candidateServingCount > 0
        ? Math.ceil(assignableAccountCount / candidateServingCount)
        : 0
      : world.spec.capacity.targetPerNode;

  const decisions: NodeRoleDecision[] = [];
  const roleSets: RoleSets = {
    serving: new Set(),
    quarantined: new Set(),
    evicted: new Set(),
    paused: new Set()
  };

  for (const proxy of world.proxies) {
    const local = world.localByProxyId.get(proxy.id);
    const currentLoad = (world.accountsByProxyId.get(proxy.id) ?? []).length;

    let role: NodeRoleDecision["role"] = "standby";
    let backoffUntilIso: string | null = null;
    let backoffAttempts = local?.backoffAttempts ?? 0;
    let healthScore: number | null = local?.healthScore ?? null;
    let nextAction = "等待启用";

    if (world.protectedProxyIds.has(proxy.id)) {
      nextAction = "保护代理，不参与自动调度";
    } else if (proxy.id === world.intakeProxyId) {
      nextAction =
        currentLoad > 0 ? `入站代理，下次将引流 ${currentLoad} 个账号` : "入站代理，当前无待引流账号";
    } else if (!world.managedProxyIds.has(proxy.id) || !local) {
      // 非托管代理或本地无对应节点 → 不参与编排
      nextAction = "非托管代理或本地未记录，不参与编排";
    } else if (
      local.lifecycleStatus === "retired" ||
      local.lifecycleStatus === "deleted" ||
      local.lifecycleStatus === "draining" ||
      local.lifecycleStatus === "cooling_down"
    ) {
      // "下线意图"：账号必须迁走
      //   • retired       永久退役
      //   • deleted       删除中
      //   • draining      排空中
      //   • cooling_down  冷却（测试失败自动 / 用户判定节点有问题）— 跟 retired 的
      //                   区别仅在意图持久性，对 reconcile 而言都是"账号别留在这"
      role = "evicted";
      // UI 显示的 lifecycle 中文映射（reconcile 在 core 包不能引用 web 的 formatter）
      const lifecycleLabel =
        local.lifecycleStatus === "retired"
          ? "已退役"
          : local.lifecycleStatus === "deleted"
            ? "已删除"
            : local.lifecycleStatus === "draining"
              ? "排空中"
              : local.lifecycleStatus === "cooling_down"
                ? "冷却中"
                : local.lifecycleStatus;
      nextAction = `用户标记${lifecycleLabel}，等待账号全部迁出`;
    } else if (local.lifecycleStatus === "disabled") {
      // 用户手动锁定（disabled lifecycle，UI 显示"已锁定"，P5-AE 术语统一）：
      //   • 已绑账号留在原地（不触发 rebind_dead）
      //   • 不接收新账号（不进 servingProxies）
      //   • 不自动恢复（跟 quarantined 的本质区别 — quarantined 到期会重测）
      //   • 用户要恢复需要主动点"启用调度"
      // role 仍叫 "paused" 保持 schema 稳定；UI 通过 RoleBadge 映射显示"已锁定"
      role = "paused";
      nextAction = "已锁定，账号留原地不迁、不接新；需要主动启用调度才恢复";
    } else if (
      local.status === "failed" ||
      !local.schedulable ||
      local.lifecycleStatus === "candidate" ||
      local.lifecycleStatus === "testing"
    ) {
      // 防御不一致状态：历史订阅刷新/手动测试可能留下
      // candidate + sub2apiProxyId + intent=serving 这种组合。只要本地已明确
      // 不可调度或测试失败，就不能继续承载账号。
      role = "evicted";
      nextAction = local.status === "failed"
        ? "节点测试失败，等待账号全部迁出"
        : "节点未启用调度，等待清理遗留绑定";
    } else {
      // 状态机入口：根据 local 当前角色 + healthSignals 决定下一态
      const previousRole = local.intentRole ?? (local.lifecycleStatus === "schedulable" ? "serving" : "standby");
      const signal = world.healthSignals.get(proxy.id);
      // 有信号即可参与判定（错误数 0 也是有效信号"窗口内无错"）
      const haveSignal = signal !== undefined;
      const errors = signal?.errorsInWindow ?? 0;
      const errorOverThreshold = haveSignal && errors >= world.spec.health.errorBudgetPerWindow;
      const backoffUntilDate = local.backoffUntil ? new Date(local.backoffUntil) : null;
      const backoffStillActive = backoffUntilDate ? backoffUntilDate > world.nowDate : false;

      if (haveSignal) {
        // 每条错误扣 5 分，封顶 100 / 0
        healthScore = Math.max(0, Math.min(100, 100 - errors * 5));
      }

      if (signal?.localListenerDown) {
        // listener 消失意味着 Sub2API 必然 connection refused，留在 quarantined
        // 不迁账号只会延长故障。只要还有其他 serving 节点就立即迁出。
        role = "evicted";
        healthScore = 0;
        backoffUntilIso = null;
        nextAction = "本地 listener 不可达，立即迁出账号";
      } else if (previousRole === "evicted") {
        role = "evicted";
        nextAction = "已驱逐，等待人工恢复或重置";
      } else if (previousRole === "quarantined" && backoffStillActive) {
        role = "quarantined";
        const remaining = Math.max(0, backoffUntilDate!.getTime() - world.nowDate.getTime());
        nextAction = `退避中，${formatRemainingMs(remaining)} 后自动重测`;
      } else if (previousRole === "quarantined") {
        // 退避到期，依据 health 决定恢复或加深退避
        if (!haveSignal) {
          role = "quarantined";
          nextAction = "退避到期但暂无上游错误信号，再等一个周期";
        } else if (errorOverThreshold) {
          backoffAttempts += 1;
          if (backoffAttempts > world.spec.health.evictAfterBackoffs) {
            role = "evicted";
            backoffUntilIso = null;
            nextAction = `连续 ${backoffAttempts} 次失败，永久驱逐`;
          } else {
            role = "quarantined";
            const duration = pickBackoffDuration(world.spec.health.backoffSequenceMs, backoffAttempts);
            const newUntil = new Date(world.nowDate.getTime() + duration);
            backoffUntilIso = newUntil.toISOString();
            nextAction = `窗口内 ${errors} 条错误 ≥ 预算，进入第 ${backoffAttempts} 阶段退避（${formatMs(duration)}）`;
          }
        } else {
          role = "serving";
          backoffUntilIso = null;
          nextAction = errors > 0 ? `恢复服务，窗口内仅 ${errors} 条错误` : "恢复服务";
        }
      } else {
        // serving / standby promoted 检查 health
        if (errorOverThreshold) {
          backoffAttempts += 1;
          if (backoffAttempts > world.spec.health.evictAfterBackoffs) {
            role = "evicted";
            backoffUntilIso = null;
            nextAction = `累计失败 ${backoffAttempts} 次，永久驱逐`;
          } else {
            role = "quarantined";
            const duration = pickBackoffDuration(world.spec.health.backoffSequenceMs, backoffAttempts);
            const newUntil = new Date(world.nowDate.getTime() + duration);
            backoffUntilIso = newUntil.toISOString();
            nextAction = `窗口内 ${errors} 条错误超出预算 ${world.spec.health.errorBudgetPerWindow}，进入退避（${formatMs(duration)}）`;
          }
        } else {
          role = "serving";
          backoffUntilIso = null;
        }
      }
    }

    if (role === "serving") {
      const upper = Math.ceil(target * world.spec.capacity.overloadRatio);
      const lower = Math.floor(target * world.spec.capacity.underloadRatio);
      if (currentLoad > upper) {
        nextAction = `过载（${currentLoad} > ${upper}），下次将外迁 ${currentLoad - target} 个账号`;
      } else if (currentLoad < lower && target > 0) {
        nextAction = `欠载（${currentLoad} < ${lower}），等待新账号填入`;
      } else if (healthScore !== null) {
        nextAction = `承载 ${currentLoad}/${target}，健康分 ${healthScore}`;
      } else {
        nextAction = `承载 ${currentLoad}/${target}`;
      }
    }

    if (role === "serving") roleSets.serving.add(proxy.id);
    else if (role === "quarantined") roleSets.quarantined.add(proxy.id);
    else if (role === "evicted") roleSets.evicted.add(proxy.id);
    else if (role === "paused") roleSets.paused.add(proxy.id);

    decisions.push({
      proxyId: proxy.id,
      proxy,
      localNode: local,
      role,
      currentLoad,
      targetLoad: target,
      nextAction,
      backoffUntilIso,
      backoffAttempts,
      healthScore
    });
  }

  return { decisions, roleSets };
}

function countCandidateServing(world: ObservedWorld): number {
  let count = 0;
  for (const proxy of world.proxies) {
    if (world.protectedProxyIds.has(proxy.id)) continue;
    if (proxy.id === world.intakeProxyId) continue;
    if (!world.managedProxyIds.has(proxy.id)) continue;
    const local = world.localByProxyId.get(proxy.id);
    if (!local) continue;
    if (local.status === "failed") continue;
    if (!local.schedulable) continue;
    if (local.lifecycleStatus !== "schedulable") continue;
    if (local.intentRole === "evicted") continue;
    if (local.intentRole === "paused") continue;
    count += 1;
  }
  return count;
}

function pickBackoffDuration(sequence: number[], attempt: number): number {
  if (sequence.length === 0) return 60_000;
  const idx = Math.min(attempt - 1, sequence.length - 1);
  return sequence[Math.max(0, idx)] ?? 60_000;
}

function formatMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function formatRemainingMs(ms: number): string {
  if (ms <= 0) return "0s";
  return formatMs(ms);
}

// ──────────────────────────────────────────────────────────────────────────
// Step 3 — plan

function planChanges(
  world: ObservedWorld,
  decisions: NodeRoleDecision[],
  roleSets: RoleSets
): ReconcilePlannedChange[] {
  const planned: ReconcilePlannedChange[] = [];
  const servingProxies = decisions
    .filter((d) => d.role === "serving" && !world.protectedProxyIds.has(d.proxyId))
    .map((d) => d.proxy);

  if (servingProxies.length === 0) {
    return planned;
  }

  // priority 1 — drain intake
  if (world.intakeProxyId !== null) {
    const intakeAccounts = world.accountsByProxyId.get(world.intakeProxyId) ?? [];
    const intakeProxy = world.proxiesById.get(world.intakeProxyId);
    for (const account of intakeAccounts) {
      const target = pickTargetProxy(account, servingProxies, world.spec.stickiness.strategy);
      if (!target) continue;
      planned.push({
        kind: "drain_intake",
        accountId: account.id,
        accountName: account.name,
        fromProxyId: world.intakeProxyId,
        toProxyId: target.id,
        fromProxyName: intakeProxy?.name ?? null,
        toProxyName: target.name,
        reason: "新账号从入站代理引流到 Hive 节点"
      });
    }
  }

  // priority 2 — bind_missing / rebind_dead
  for (const account of world.uniqueAccounts) {
    if (account.proxy_id && world.protectedProxyIds.has(account.proxy_id)) continue;
    // intake 上的账号已经在第 1 步处理过；只有 intakeProxyId 非 null 且账号确实绑在 intake 上时才 skip
    if (world.intakeProxyId !== null && account.proxy_id === world.intakeProxyId) continue;

    const proxyId = account.proxy_id ?? null;
    // 决策 #5 + paused 扩展：account 视为 alive 不触发 rebind_dead 的代理角色：
    //   • serving      = 健康正常
    //   • quarantined  = 自动退避中，到期会重测恢复
    //   • paused       = 用户手动暂停，账号留原地直到用户启用回来
    // 只有 evicted 或代理完全不存在才算 dead 触发 rebind。
    const proxyAlive =
      proxyId !== null &&
      !roleSets.evicted.has(proxyId) &&
      (roleSets.serving.has(proxyId) || roleSets.quarantined.has(proxyId) || roleSets.paused.has(proxyId));

    if (!proxyAlive) {
      const target = pickTargetProxy(account, servingProxies, world.spec.stickiness.strategy);
      if (!target) continue;
      if (target.id === proxyId) continue;
      const fromProxy = proxyId !== null ? world.proxiesById.get(proxyId) : undefined;
      planned.push({
        kind: proxyId === null ? "bind_missing" : "rebind_dead",
        accountId: account.id,
        accountName: account.name,
        fromProxyId: proxyId,
        toProxyId: target.id,
        fromProxyName: fromProxy?.name ?? null,
        toProxyName: target.name,
        reason: proxyId === null ? "账号未绑定，自动分配到健康节点" : "原代理已退避/驱逐/不再服务"
      });
    }
  }

  // priority 3 — rebalance overload
  const overloadDecisions = decisions.filter(
    (d) => d.role === "serving" && d.currentLoad > Math.ceil(d.targetLoad * world.spec.capacity.overloadRatio)
  );
  for (const overloadNode of overloadDecisions) {
    const exceed = overloadNode.currentLoad - overloadNode.targetLoad;
    if (exceed <= 0) continue;
    const candidates = (world.accountsByProxyId.get(overloadNode.proxyId) ?? [])
      .filter((acc) => !(acc.proxy_id && world.protectedProxyIds.has(acc.proxy_id)))
      .slice()
      .sort((a, b) => b.id - a.id); // LIFO 倾向把最近迁入的搬走

    let migrated = 0;
    for (const account of candidates) {
      if (migrated >= exceed) break;
      const otherServing = servingProxies.filter((p) => p.id !== overloadNode.proxyId);
      const target = pickTargetProxy(account, otherServing, world.spec.stickiness.strategy);
      if (!target) continue;
      planned.push({
        kind: "rebalance_overload",
        accountId: account.id,
        accountName: account.name,
        fromProxyId: overloadNode.proxyId,
        toProxyId: target.id,
        fromProxyName: overloadNode.proxy.name,
        toProxyName: target.name,
        reason: `过载外迁：节点承载 ${overloadNode.currentLoad} > 上限 ${Math.ceil(
          overloadNode.targetLoad * world.spec.capacity.overloadRatio
        )}`
      });
      migrated += 1;
    }
  }

  // priority 4 / 5 — drift_correction & rebalance_fill：阶段 A 暂不实现
  return planned;
}

// ──────────────────────────────────────────────────────────────────────────
// Step 4 — gate (灰度限速 + 暂停)

function gateChanges(
  world: ObservedWorld,
  planned: ReconcilePlannedChange[]
): { applied: ReconcilePlannedChange[]; skippedReason: ReconcileSkippedReason } {
  if (!world.enabled) {
    return { applied: [], skippedReason: "paused" };
  }
  if (planned.length === 0) {
    return { applied: [], skippedReason: "no_change" };
  }

  const priority: Record<ReconcilePlannedChange["kind"], number> = {
    drain_intake: 0,
    rebind_dead: 1,
    bind_missing: 2,
    rebalance_overload: 3,
    rebalance_fill: 4,
    drift_correction: 5
  };
  const sorted = planned.slice().sort((a, b) => priority[a.kind] - priority[b.kind]);

  const total = world.uniqueAccounts.length;
  const percentCap = Math.floor((total * world.spec.graceBatchPercent) / 100);
  const absCap = world.spec.graceBatchAbs;
  const generalCap = Math.max(0, Math.min(percentCap, absCap));
  const migrationCap = world.spec.stickiness.perTickMigrationCap;
  const bypass = world.spec.intake.bypassGraceBatch;

  const applied: ReconcilePlannedChange[] = [];
  let generalCount = 0;
  let migrationCount = 0;

  for (const change of sorted) {
    const isIntake = change.kind === "drain_intake";
    const isMigration = change.kind === "rebalance_overload" || change.kind === "drift_correction";

    if (isMigration && migrationCount >= migrationCap) continue;

    if (isIntake && bypass) {
      applied.push(change);
      continue; // 不消耗 generalCap
    }

    if (generalCount >= generalCap) continue;
    applied.push(change);
    generalCount += 1;
    if (isMigration) migrationCount += 1;
  }

  if (applied.length === 0) return { applied, skippedReason: "batch_capped" };
  return { applied, skippedReason: "applied" };
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers

function summarizeObserved(world: ObservedWorld, decisions: NodeRoleDecision[]): ReconcileObservedSummary {
  const proxiesTotal = world.proxiesById.size;
  const proxiesServing = decisions.filter((d) => d.role === "serving").length;
  const proxiesQuarantined = decisions.filter((d) => d.role === "quarantined").length;
  const proxiesEvicted = decisions.filter((d) => d.role === "evicted").length;
  const accountsTotal = world.uniqueAccounts.length;
  const accountsProtected = world.uniqueAccounts.filter(
    (a) => a.proxy_id && world.protectedProxyIds.has(a.proxy_id)
  ).length;
  const accountsAssignable = accountsTotal - accountsProtected;
  const capacityTotal = decisions
    .filter((d) => d.role === "serving")
    .reduce((sum, d) => sum + Math.ceil(d.targetLoad * world.spec.capacity.overloadRatio), 0);
  const utilizationPercent =
    capacityTotal === 0 ? 0 : Math.min(100, Math.round((accountsAssignable / capacityTotal) * 100));

  return reconcileObservedSummarySchema.parse({
    proxiesTotal,
    proxiesServing,
    proxiesQuarantined,
    proxiesEvicted,
    proxiesProtected: world.protectedProxyIds.size,
    proxiesManaged: world.managedProxyIds.size,
    accountsTotal,
    accountsAssignable,
    accountsProtected,
    capacityTotal,
    utilizationPercent
  });
}

function buildNodeIntents(world: ObservedWorld, decisions: NodeRoleDecision[]): ReconcileNodeIntent[] {
  return decisions
    .filter((d) => world.localByProxyId.has(d.proxyId))
    .map((d) => {
      const local = world.localByProxyId.get(d.proxyId)!;
      const proxy = world.proxiesById.get(d.proxyId);
      return {
        hash: local.hash,
        proxyId: d.proxyId,
        intentRole: d.role,
        healthScore: d.healthScore,
        backoffUntil: d.backoffUntilIso,
        backoffAttempts: d.backoffAttempts,
        currentLoad: d.currentLoad,
        targetLoad: d.targetLoad,
        nextAction: d.nextAction,
        localName: local.name ?? null,
        proxyName: proxy?.name ?? null,
        host: proxy?.host ?? null,
        port: proxy?.port ?? null,
        country: proxy?.country_code ?? proxy?.country ?? null,
        protocol: proxy?.protocol ?? null
      };
    });
}

function dedupeAccounts(accounts: Sub2ApiAccountRecord[]): Sub2ApiAccountRecord[] {
  const seen = new Set<number>();
  const out: Sub2ApiAccountRecord[] = [];
  for (const account of accounts) {
    if (seen.has(account.id)) continue;
    seen.add(account.id);
    out.push(account);
  }
  return out;
}

function pickTargetProxy(
  account: Sub2ApiAccountRecord,
  pool: Sub2ApiProxyRecord[],
  strategy: "stable-hash" | "rendezvous-hash"
): Sub2ApiProxyRecord | undefined {
  if (pool.length === 0) return undefined;
  if (strategy === "rendezvous-hash") return pickRendezvousProxy(account, pool);
  const key = `${account.id}:${account.name}`;
  const digest = createHash("sha256").update(key).digest();
  const index = digest.readUInt32BE(0) % pool.length;
  return pool[index];
}

function pickRendezvousProxy(account: Sub2ApiAccountRecord, pool: Sub2ApiProxyRecord[]): Sub2ApiProxyRecord {
  let best: { proxy: Sub2ApiProxyRecord; weight: number } | undefined;
  for (const proxy of pool) {
    const key = `${proxy.id}:${account.id}`;
    const digest = createHash("sha256").update(key).digest();
    const weight = digest.readUInt32BE(0);
    if (!best || weight > best.weight) best = { proxy, weight };
  }
  return best!.proxy;
}

/**
 * Validate the intake config against the rest of Spec. Returns an error message
 * if the config is illegal (used in spec.save preflight).
 */
export function validateIntakeAgainstSpec(
  spec: OrchestrationSpec,
  proxies: Sub2ApiProxyRecord[],
  managedProxyPrefix: string
): string | null {
  const id = spec.intake.proxyId;
  if (id === null) return null;
  const proxy = proxies.find((p) => p.id === id);
  if (!proxy) return "入站代理在 Sub2API 中已不存在";
  if (isManagedProxy(proxy, managedProxyPrefix)) {
    return "入站代理不能是 Hive 托管代理（带托管前缀）";
  }
  if (matchesProtectedProxy(proxy, spec.protectedRule)) {
    return "入站代理不能命中保护规则";
  }
  return null;
}
