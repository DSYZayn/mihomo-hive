/**
 * AccountJobsWorker —— 异步消费 account_jobs 队列。
 *
 * 设计文档：notes/account-fleet-design.md §9 (Jobs Worker 与 codex-tool adapter)
 *
 * 设计原则：
 *   - 每次 poll 一条 status='queued' AND scheduled_at ≤ now 的 job
 *   - 受 spec.recovery.maxConcurrent 限制总并发
 *   - 每个 kind 走对应 handler；handler 失败 → 写 error + 更新账号 backoff
 *   - 完成后立刻 poll 下一条（直到 queue 空 / 并发满）
 *   - 失败的 account 会被 scheduler 下个 tick 按 backoffSequenceMs 重新规划
 *
 * 安全：
 *   - codex-tool stdout 含完整 token，**不落日志**——adapter 内部解析后即刻 GC
 *   - jobs.payloadJson / resultJson 入库前用 safeRedact 过一遍敏感字段
 */

import { randomUUID } from "node:crypto";
import {
  buildEgressLoadMap,
  createAgentSpawner,
  createCodexToolAdapter,
  createSub2ApiClient,
  loadAccountCrypto,
  NoEgressAvailableError,
  proxyNameForNode,
  selectEgressForLogin,
  selectEgressForRegister,
  type AccountCrypto,
  type CodexToolAdapter,
  type CodexToolConfig,
  type CodexToolSpawner,
  type EgressSelection,
  type Sub2ApiClient
} from "@mihomo-hive/core";
import { setProxyGroupSelection } from "@mihomo-hive/mihomo";
import { HiveRepository } from "@mihomo-hive/db";
import { defaultRuntimeConfig, type RuntimeConfig } from "@mihomo-hive/schemas";
import type {
  AccountFleetSpec,
  AccountJob,
  AccountRecordInternal,
  ProxyNode,
  Sub2ApiCreateAccountPayload
} from "@mihomo-hive/schemas";
import { budgetWindowKey } from "./account-fleet-orchestrator.js";
import { codexEgressRuntime, isAgentHealthy } from "./codex-egress.js";
import { appendJobLog, finalizeJobLog } from "./job-log-buffer.js";

export interface AccountJobsWorkerHandle {
  /** 立刻尝试 poll 一次（测试 / UI 手动触发用）。 */
  pump: () => Promise<void>;
  stop: () => void;
}

/**
 * 全局串行闸门：保证同一时刻只有一个 codex-tool 调用在跑（P5-AP 实测）。
 *
 * 背景：worker 按 spec.recovery.maxConcurrent 并发跑 job，但 codex-tool 的 login/
 * register 会起 Playwright chromium 抓 Sentinel。两个 chromium 在小机器上同时跑，
 * Cloudflare 重保护页加载极易 ERR_CONNECTION_CLOSED / 提取不到 token（用户手动单跑
 * 几乎不遇到）。所以把 codex-tool 的 chromium 类调用串行化 —— 其它 job（delete/
 * toggle/observe，不起 chromium）仍可并发。锁是 promise 链，先到先跑、依次释放。
 */
let codexToolGate: Promise<unknown> = Promise.resolve();
function withCodexToolLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = codexToolGate.then(fn, fn);
  // 无论成功失败都释放（吞掉结果，仅作链式排队），让下一个排队者继续
  codexToolGate = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export interface AccountJobsWorkerOptions {
  repo: HiveRepository;
  /**
   * 用于解密 enc_phone / enc_password / enc_refresh_token 的加密器。
   * 默认从 process.env.HIVE_ACCOUNT_KEY 加载；测试可注入。
   */
  crypto?: AccountCrypto;
  /** 默认 5_000ms。worker 空闲时等多久再 poll。 */
  idlePollMs?: number;
  /** 测试用：禁用自动循环，只通过 pump() 触发。 */
  manualOnly?: boolean;
  /** 运行时配置（external-controller 地址/secret，用于外置 agent 动态切出口组）。 */
  config?: RuntimeConfig;
}

export function startAccountJobsWorker(options: AccountJobsWorkerOptions): AccountJobsWorkerHandle {
  const { repo } = options;
  const crypto = options.crypto ?? safeLoadCrypto();
  const runtimeConfig = options.config ?? defaultRuntimeConfig;
  const idlePollMs = options.idlePollMs ?? 5_000;
  let stopped = false;
  let pollTimer: NodeJS.Timeout | undefined;
  let running = 0;
  // agent 类 job(登录/注册)必须严格单飞：它们最终都打到同一个 codex-tool serve,
  // serve 内部有全局 run_lock 串行化——两个并发的注册,第二个会吃 503 busy 被白白浪费
  // (还可能撞 Cloudflare 风控)。所以无论 maxConcurrent 多大,同一时刻只允许一个 agent job;
  // import 等非 agent 类 job 仍可按 maxConcurrent 并发。claim→标 running 之间无 await,
  // agentRunning 的读写在同一事件循环 tick 内,并发的 tryConsumeOne 不会漏判。
  let agentRunning = false;
  const AGENT_KINDS = ["codex_login", "codex_register"];

  async function tryConsumeOne(): Promise<boolean> {
    const spec = repo.getAccountFleetSpec();
    const maxConcurrent = Math.max(1, spec.recovery.maxConcurrent);
    if (running >= maxConcurrent) return false;
    // 已有 agent job 在跑 → 本次只认非 agent 类 job,把登录/注册留到它跑完再抢。
    const job = repo.claimNextAccountJob(
      undefined,
      agentRunning ? { excludeKinds: AGENT_KINDS } : undefined
    );
    if (!job) return false;
    const isAgentJob = job.kind === "codex_login" || job.kind === "codex_register";
    // P5-AV 执行前防御：恢复类 job 真正 spawn codex-tool 之前，复查账号当前状态。
    // 若账号已退役（多为 account_unusable 死账号）→ 直接作废这条残留 queued job，
    // 不浪费串行 codex-tool 槽位死磕。返回 true 让 poll 立刻继续下一条。
    if (job.accountId && (job.kind === "codex_login" || job.kind === "codex_register")) {
      const acc = repo.getAccountById(job.accountId);
      if (acc && acc.intent === "retired") {
        // P6-14：直接删除这条 stale 任务（不留 cancelled 墓碑污染列表）。打日志保留信号——
        // 若它频繁触发，说明有"给已退役账号入队"的真问题需要排查（正常情况几乎不该发生）。
        repo.deleteAccountJob(job.id);
        console.log(`AccountJobsWorker: 删除已退役账号 ${job.accountId} 的 stale ${job.kind} 任务（执行前拦截）。`);
        return true;
      }
      // 运维已暂停的账号：执行前拦截删除残留任务(防 disable 与入队竞态)，不占串行槽位。
      if (acc && acc.opsEnabled === false) {
        repo.deleteAccountJob(job.id);
        return true;
      }
    }
    // 抢占式：再次检查后才标 running，避免重复消费
    running++;
    if (isAgentJob) agentRunning = true;
    const startedAt = new Date();
    repo.updateAccountJob(job.id, {
      status: "running",
      startedAt: startedAt.toISOString(),
      attempt: job.attempt + 1
    });
    appendJobLog(job.id, `▶ 开始执行 ${job.kind}（尝试 ${job.attempt + 1}/${job.maxAttempts}）`);
    try {
      await executeJob(job, spec);
      appendJobLog(job.id, `✓ 执行成功`);
      repo.updateAccountJob(job.id, {
        status: "succeeded",
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        logTail: finalizeJobLog(job.id)
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "未知错误";
      appendJobLog(job.id, `✗ 失败: ${redactErrorMessage(message)}`);
      repo.updateAccountJob(job.id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        errorMessage: redactErrorMessage(message),
        logTail: finalizeJobLog(job.id)
      });
      // 同步 account.recoveryAttempts / nextRecoveryAfter
      //
      // 例外：NoEgressAvailableError 是"基础设施暂时空"（节点池没可用节点），不是
      // 账号本身的问题。如果计入 recoveryAttempts，会因为节点池抖动把无辜账号烧掉，
      // 所以这里不更新 attempts —— 下个 tick 节点池恢复后会重新规划。
      const isInfraIssue = err instanceof NoEgressAvailableError;
      if (
        !isInfraIssue &&
        job.accountId &&
        (job.kind === "codex_login" || job.kind === "codex_register")
      ) {
        applyRecoveryFailure(repo, spec, job, message);
      }
    } finally {
      running--;
      if (isAgentJob) agentRunning = false;
    }
    return true;
  }

  async function executeJob(job: AccountJob, spec: AccountFleetSpec): Promise<void> {
    switch (job.kind) {
      case "codex_login":
        return runCodexLogin(repo, crypto, spec, job, runtimeConfig);
      case "codex_register":
        return runCodexRegister(repo, crypto, spec, job, runtimeConfig);
      case "import_to_sub2api":
        return runImportToSub2api(repo, crypto, spec, job);
      case "delete_sub2api":
        return runDeleteSub2api(repo, spec, job);
      case "toggle_schedulable":
        return runToggleSchedulable(repo, spec, job);
      case "observe_usage":
        return runObserveUsage(repo, spec, job);
      case "import_codex_tool_account":
        return runImportCodexToolAccount(repo, crypto, spec, job);
      default:
        throw new Error(`Unknown job kind: ${job.kind satisfies never}`);
    }
  }

  async function poll(): Promise<void> {
    try {
      // 尽量消化所有可消费的 job（直到没有 / 并发满）
      while (!stopped) {
        const consumed = await tryConsumeOne();
        if (!consumed) break;
      }
    } catch (err) {
      console.error("AccountJobsWorker poll loop error:", err);
    }
    if (stopped || options.manualOnly) return;
    pollTimer = setTimeout(poll, idlePollMs);
    pollTimer.unref?.();
  }

  if (!options.manualOnly) {
    // 启动前清理上一进程残留的僵尸 running job（容器重建后它们永远卡在 running、
    // 既污染"进行中"视图又不会被重新认领）。重置为 queued 让 poll 重新消费。
    try {
      const revived = repo.resetStaleRunningAccountJobs();
      if (revived > 0) {
        console.log(`AccountJobsWorker: reset ${revived} stale running job(s) → queued on startup.`);
      }
      // P5-AV：清掉历史堆积的"死账号(已退役)"queued 恢复任务，别再死磕。
      const purged = repo.cancelQueuedJobsForRetiredAccounts();
      if (purged > 0) {
        console.log(`AccountJobsWorker: cancelled ${purged} queued job(s) for retired accounts on startup.`);
      }
      // P5-AV：去重 —— 每个账号只留一条 queued 恢复任务，清掉上线前堆积的重复。
      const deduped = repo.dedupeQueuedRecoveryJobs();
      if (deduped > 0) {
        console.log(`AccountJobsWorker: de-duplicated ${deduped} redundant queued recovery job(s) on startup.`);
      }
      // P6-14：清掉历史 cancelled 墓碑（之前用 UPDATE→cancelled 留下的运维清理记录，
      // 现已改为直接删除；这里把存量墓碑一次性清掉，让"最近完成"回归真实执行结果）。
      const purgedTombstones = repo.deleteCancelledJobs();
      if (purgedTombstones > 0) {
        console.log(`AccountJobsWorker: purged ${purgedTombstones} legacy cancelled tombstone job(s) on startup.`);
      }
    } catch (err) {
      console.warn("AccountJobsWorker: failed to reset stale running jobs:", err);
    }
    void poll();
  }

  return {
    pump: async () => {
      while (true) {
        const consumed = await tryConsumeOne();
        if (!consumed) break;
      }
    },
    stop: () => {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
    }
  };
}

// ─── Job handlers ────────────────────────────────

/**
 * PATH_A: codex_login —— spawn codex-tool login → fresh tokens →
 *   POST /admin/openai/refresh-token → POST /admin/accounts → (可选) DELETE 旧
 *
 * Job payload: { accountId }
 * 成功后 account.intent='active' + origin 升级（adopted→recovered）+ encRefreshToken 更新
 *
 * 代理选择：优先尝试 account.egressNodeHash 对应的节点（软粘性）；
 * 不可用时按质量+负载加权随机回退。
 */
async function runCodexLogin(
  repo: HiveRepository,
  crypto: AccountCrypto,
  spec: AccountFleetSpec,
  job: AccountJob,
  config: RuntimeConfig
): Promise<void> {
  const account = job.accountId ? repo.getAccountById(job.accountId) : undefined;
  if (!account) throw new Error("account not found for codex_login");
  const phone = crypto.decryptOptional(account.encPhone);
  const password = crypto.decryptOptional(account.encPassword);
  if (!phone || !password) throw new Error("codex_login requires encPhone + encPassword");
  await assertAgentHealthy(crypto, spec); // 外置 agent 不可达 → 抛 NoEgressAvailableError（不烧账号）
  // 标 recovering
  repo.patchAccount(account.id, { intent: "recovering" });

  const egress = resolveEgressForLogin(repo, spec, account);
  appendJobLog(job.id, egressLogLine(repo, spec, egress));
  const adapter = await buildCodexToolAdapter(repo, crypto, spec, egress, { idempotencyKey: job.id });
  appendJobLog(job.id, "调用 codex-tool login（chromium/Sentinel，串行排队中）…");
  // 串行化：codex-tool 的 chromium/Sentinel 调用不能并发（见 withCodexToolLock）。
  // P5-AS：抛出型失败（超时/非零退出）也要给节点记一笔（多为网络/代理类）。
  let outcome: Awaited<ReturnType<typeof adapter.login>>;
  try {
    outcome = await withCodexToolLock(async () => {
      await applyCodexEgress(config, spec, egress, job.id); // 动态出口：切 codex-egress 组到该节点
      return adapter.login({
        phone,
        password,
        timeoutMs: spec.codexTool.timeouts.loginMs,
        onLog: (line) => appendJobLog(job.id, `codex: ${redactErrorMessage(line)}`)
      });
    });
  } catch (err) {
    recordNodeOutcome(repo, egress, { failedMessage: err instanceof Error ? err.message : String(err) }, "login");
    throw err;
  }
  // login 失败统一抛错，由 executor catch → applyRecoveryFailure 按错误消息分类处理
  // （account_unusable 退役 / network_or_proxy 换出口重试 / oauth_failed 退避）。
  // 不在这里 patch —— 否则会和 applyRecoveryFailure 的 intent 写回打架（先退役又被翻回）。
  // outcome.classification 若有则拼进消息，让分类器也能命中 codex-tool 的判定。
  if (outcome.kind === "failed") {
    const cat = outcome.classification.failureCategory;
    const msg = cat ? `${outcome.error} [${cat}]` : outcome.error;
    recordNodeOutcome(repo, egress, { failedMessage: msg }, "login");
    throw new Error(msg);
  }
  // P5-AS：成功 = 这个节点能过 Sentinel，记一笔成功（驱动后续优先复用）
  recordNodeOutcome(repo, egress, "success", "login");
  await landOnSub2api({
    repo,
    crypto,
    spec,
    account,
    tokens: outcome.result.tokens,
    email: outcome.result.email,
    accountIdHint: outcome.result.accountId,
    isRecovery: true,
    egressNodeHash: egress?.hash ?? null
  });
}

/**
 * PATH_B: codex_register —— spawn codex-tool all → fresh account + token →
 *   refresh-token / createAccount → 老账号 retire（如果有 accountId）
 *
 * Job payload: { existingAccountId? } —— null 表示纯新增；非空表示替代某个废掉的
 */
async function runCodexRegister(
  repo: HiveRepository,
  crypto: AccountCrypto,
  spec: AccountFleetSpec,
  job: AccountJob,
  config: RuntimeConfig
): Promise<void> {
  await assertAgentHealthy(crypto, spec); // 外置 agent 不可达 → NoEgressAvailableError（不烧额度）
  // 注册：按质量+负载加权随机选 egress，让新账号 IP 出生地自然分散
  const egress = resolveEgressForRegister(repo, spec);
  appendJobLog(job.id, egressLogLine(repo, spec, egress));
  const adapter = await buildCodexToolAdapter(repo, crypto, spec, egress, { idempotencyKey: job.id });
  appendJobLog(job.id, "调用 codex-tool all（注册 + OAuth，串行排队中）…");
  // 串行化：与 login 共用同一闸门，避免两个 chromium 同时跑
  let outcome: Awaited<ReturnType<typeof adapter.registerOne>>;
  try {
    outcome = await withCodexToolLock(async () => {
      await applyCodexEgress(config, spec, egress, job.id); // 动态出口：切 codex-egress 组到该节点
      return adapter.registerOne({
        timeoutMs: spec.codexTool.timeouts.registerMs,
        onLog: (line) => appendJobLog(job.id, `codex: ${redactErrorMessage(line)}`)
      });
    });
  } catch (err) {
    recordNodeOutcome(repo, egress, { failedMessage: err instanceof Error ? err.message : String(err) }, "register");
    throw err;
  }
  const oldAccount = job.accountId ? repo.getAccountById(job.accountId) : undefined;

  // P5-AI: 不管成功失败，只要 codex-tool 返回了 sms_region_result 就回灌经验
  // （codex-tool 决定怎么用，Hive 透明保存）；并按实际花费记账，让月度成本预算有意义。
  // P6-09: succeeded 决定是否计入"今日注册"额度 —— 只有真注册成功(token_ready)才 +1，
  // 失败尝试只记花费、不占注册额度（否则失败会把 dailyBudget 烧光锁死自动注册）。
  const persistSms = (
    sms: { result: unknown; costUsd: number | null },
    country: string | null,
    succeeded: boolean
  ) => {
    if (sms.result != null) repo.saveSmsRegionHint(sms.result);
    const costCents = sms.costUsd != null ? Math.round(sms.costUsd * 100) : 0;
    incrementRegistrationsBudget(repo, spec, {
      deltaRegistrations: succeeded ? 1 : 0,
      deltaSmsCostCents: costCents
    });
    return { costCents: sms.costUsd != null ? costCents : null, country };
  };

  if (outcome.kind === "registration_failed") {
    // 接码失败一般不收费（cost=0），但仍把 sms_region_result 经验回灌给 codex-tool。
    persistSms(outcome.sms, outcome.sms.country, false);
    const attemptCount = Array.isArray(outcome.sms.attempts) ? outcome.sms.attempts.length : 0;
    // P5-AX：归因 —— 注册失败不无脑透传原始错误。取不到号 / 取到号收不到验证码都归为
    // "地区不可用"（不是账号/节点问题，不退役账号、不罚节点）。带上尝试地区数便于判断。
    const reason = describeRegistrationFailure(outcome.error, attemptCount);
    appendJobLog(job.id, `归因：${reason}`);
    if (outcome.sms.result == null && attemptCount > 0) {
      // codex-tool 试了多个地区却没回灌 sms_region_result → 经验没法持久化，记一笔提醒
      appendJobLog(job.id, `注意：codex-tool 未返回 sms_region_result，本次 ${attemptCount} 次地区尝试经验无法持久化`);
    }
    throw new Error(reason);
  }
  if (outcome.kind === "oauth_failed") {
    const { costCents, country } = persistSms(outcome.recoverable.sms, outcome.recoverable.sms.country, false);
    // P5-AS：OAuth 失败若属网络/代理/Sentinel 类，给节点记一笔失败（account_unusable 不记）
    recordNodeOutcome(repo, egress, {
      failedMessage: `${outcome.recoverable.error} [${outcome.recoverable.classification.failureCategory ?? "oauth_failed"}]`
    }, "register");
    // 按 OAuth 失败分类决定怎么落库（external-integration.md §"OAuth 失败分类"）：
    //   account_unusable → 直接 retired，不进恢复队列
    //   network_or_proxy → 进恢复队列但拉长延后，可能换代理后能救
    //   oauth_failed     → 普通恢复队列（旧行为）
    //   null（老版本 codex-tool）→ 兜底按 oauth_failed
    const category = outcome.recoverable.classification.failureCategory ?? "oauth_failed";
    const baseIntent = category === "account_unusable" ? "retired" : "recovering";
    const recoveryJson = JSON.stringify(outcome.recoverable.recoveryInput);
    const newRow: AccountRecordInternal = makeFreshAccount({
      email: `oauth-failed-${Date.now()}`,
      origin: "hive_registered",
      intent: baseIntent,
      health: "broken",
      encPhone: crypto.encryptOptional(outcome.recoverable.phone),
      encPassword: crypto.encryptOptional(outcome.recoverable.password),
      encRecoveryInputJson: crypto.encryptOptional(recoveryJson),
      batchId: outcome.recoverable.batchId,
      egressNodeHash: egress?.hash ?? null,
      smsCountry: country,
      smsCostCents: costCents,
      lastRecoveryError: redactErrorMessage(outcome.recoverable.error),
      lastRecoveryFailureCategory: category,
      // network_or_proxy 时取退避序列第二档（粗略给代理切换留余地，避免立刻撞同样问题）
      nextRecoveryAfter:
        category === "network_or_proxy"
          ? new Date(
              Date.now() + (spec.recovery.backoffSequenceMs[1] ?? spec.recovery.backoffSequenceMs[0] ?? 60_000)
            ).toISOString()
          : null
    });
    repo.upsertAccount(newRow);
    throw new Error(
      `oauth_failed[${category}]; recoverable account saved as ${newRow.id}: ${outcome.recoverable.error}`
    );
  }

  // token_ready
  // P5-AS：注册成功 = 节点能过 Sentinel，记一笔成功
  recordNodeOutcome(repo, egress, "success", "register");
  const { costCents, country } = persistSms(outcome.account.sms, outcome.account.sms.country, true);
  try {
    await landOnSub2api({
      repo,
      crypto,
      spec,
      account: oldAccount,
      tokens: outcome.account.tokens,
      email: outcome.account.email,
      accountIdHint: outcome.account.tokens.accountId,
      phone: outcome.account.phone,
      password: outcome.account.password,
      batchId: outcome.account.batchId,
      isRecovery: Boolean(oldAccount),
      isFreshRegistration: !oldAccount,
      egressNodeHash: egress?.hash ?? null,
      smsCountry: country,
      smsCostCents: costCents,
      herosmsActivationId: outcome.account.activationId
    });
  } catch (landErr) {
    // 安全网:落地(已含瞬时重试)最终仍失败 → **绝不浪费已注册的号**。把账号 + 有效
    // refresh token 存成本地 pending 记录,并入队 import_to_sub2api 后续重新落地
    // (import 路径也有 withSub2apiRetry)。这样花了钱的号永远有机会被救回,而不是直接丢。
    // 仅对"纯新注册"(无 oldAccount)做;恢复路径有 oldAccount,其状态由 applyRecoveryFailure 管。
    if (!oldAccount) {
      const salvageId = randomUUID();
      const nowIso = new Date().toISOString();
      repo.upsertAccount(
        makeFreshAccount({
          id: salvageId,
          email: outcome.account.email,
          origin: "hive_registered",
          intent: "pending", // 已注册、有 token,但尚未落 Sub2API
          health: "broken",
          encPhone: crypto.encryptOptional(outcome.account.phone),
          encPassword: crypto.encryptOptional(outcome.account.password),
          encRefreshToken: crypto.encryptOptional(outcome.account.tokens.refreshToken),
          batchId: outcome.account.batchId,
          herosmsActivationId: outcome.account.activationId,
          registeredAt: nowIso,
          smsCountry: country,
          smsCostCents: costCents,
          lastRecoveryError: redactErrorMessage(landErr instanceof Error ? landErr.message : String(landErr)),
          lastRecoveryFailureCategory: "network_or_proxy"
        })
      );
      repo.enqueueAccountJob({
        id: randomUUID(),
        kind: "import_to_sub2api",
        accountId: salvageId,
        status: "queued",
        attempt: 0,
        maxAttempts: 3, // 多给几次,跨过较长的 Sub2API 抖动窗口
        priority: 40,
        scheduledAt: new Date(Date.now() + 60_000).toISOString(), // 1 分钟后再试,等抖动过去
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        payloadJson: JSON.stringify({ refreshToken: outcome.account.tokens.refreshToken, existingAccountId: salvageId }),
        resultJson: null,
        errorMessage: null,
        triggeredBy: "scheduler",
        triggeredTickId: null,
        createdAt: nowIso,
        updatedAt: nowIso
      });
    }
    throw new Error(
      `已注册但 Sub2API 落地失败,已存本地待重新落地(import 已入队):${landErr instanceof Error ? landErr.message : String(landErr)}`
    );
  }
}

/**
 * import_to_sub2api —— 试探导入：有 refresh_token 但未在 Sub2API 中。
 * 适用：收编工作台用户提供的 refresh_token 备份。
 *
 * payload: { refreshToken }
 * 成功 → 创建本地 hive_registered（或 adopted_recovered）+ Sub2API account
 * 失败 → 备份已死，标失败
 */
async function runImportToSub2api(
  repo: HiveRepository,
  crypto: AccountCrypto,
  _spec: AccountFleetSpec,
  job: AccountJob
): Promise<void> {
  const payload = JSON.parse(job.payloadJson) as { refreshToken: string; existingAccountId?: string };
  // import_to_sub2api 不调 codex-tool —— refresh-token 和 createAccount 都是 Sub2API
  // 服务端走自己的网络发 OpenAI 请求，本地节点根本没参与。所以这里不选 egress，
  // 也不回填 egressNodeHash —— 保持 null，让后续真正用 codex-tool 的 login/register
  // 第一次跑时再选 + 回填。
  // proxy_id 用代理编排 intake 作为 fallback（没 egress 节点信息）。
  const proxyId = resolveCreationProxyId(repo, null);
  const sub2api = requireSub2apiClient(repo);
  const refreshed = await withSub2apiRetry(() =>
    sub2api.refreshOpenaiToken({ refreshToken: payload.refreshToken, proxyId })
  );
  const created = await withSub2apiRetry(() =>
    sub2api.createAccount(
      makeCreatePayload({
        spec: _spec,
        proxyId,
        tokens: {
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token,
          idToken: refreshed.id_token
        },
        email: refreshed.email,
        organizationId: refreshed.organization_id,
        clientId: refreshed.client_id,
        expiresAt: refreshed.expires_at,
        name: synthesizeName(_spec, refreshed.email)
      })
    )
  );

  const existing = payload.existingAccountId ? repo.getAccountById(payload.existingAccountId) : undefined;
  if (existing) {
    repo.patchAccount(existing.id, {
      externalId: created.id,
      origin: "adopted_recovered",
      intent: "active",
      health: "healthy",
      encRefreshToken: crypto.encryptOptional(refreshed.refresh_token),
      organizationId: refreshed.organization_id,
      clientId: refreshed.client_id,
      recoveryAttempts: 0,
      nextRecoveryAfter: null,
      lastRecoveryError: null
      // 不写 egressNodeHash：本路径没用本地节点出口
    });
  } else {
    const fresh = makeFreshAccount({
      externalId: created.id,
      email: refreshed.email,
      organizationId: refreshed.organization_id,
      clientId: refreshed.client_id,
      origin: "adopted_recovered",
      intent: "active",
      health: "healthy",
      encRefreshToken: crypto.encryptOptional(refreshed.refresh_token),
      egressNodeHash: null
    });
    repo.upsertAccount(fresh);
  }
}

/**
 * P5-AK/3c: import_codex_tool_account —— 从 codex-tool 上传的 envelope 接管账号。
 *
 * payload 由 router.adoption.codexTool.import 注入，含一条 plan item：
 * ```
 * {
 *   action: "upgrade_recovered" | "register_new" | "observed_only",
 *   sub2apiAccountId: number | null,
 *   reason: string,
 *   source: CodexAccountFromExport  // phone/password/email/refreshToken/...
 * }
 * ```
 *
 * 三分支处理（与 packages/core/codex-tool-adoption.ts:planCodexToolAdoption 对齐）：
 *   upgrade_recovered: Sub2API 已有，本地缺 enc_phone+password 或本地无
 *     → patchAccount（若 hiveLocalId）或 upsertAccount，回填凭据 + origin=adopted_recovered
 *   register_new:      Sub2API 无，codex-tool 有 refresh_token
 *     → 复用 import_to_sub2api 流程（refresh + create），落 hive_registered 同时回填 phone/password
 *   observed_only:     Sub2API 无 + codex-tool 无 refresh_token
 *     → 本地 upsert origin=adopted_observing，不调 Sub2API；提示用户后续手动跑 codex_login
 */
async function runImportCodexToolAccount(
  repo: HiveRepository,
  crypto: AccountCrypto,
  spec: AccountFleetSpec,
  job: AccountJob
): Promise<void> {
  const payload = JSON.parse(job.payloadJson) as {
    action: "upgrade_recovered" | "register_new" | "observed_only";
    sub2apiAccountId: number | null;
    reason: string;
    source: {
      id: number;
      phone: string;
      password: string;
      email: string | null;
      batchId: string | null;
      status: string;
      createdAt: string | null;
      idToken: string | null;
      accessToken: string | null;
      refreshToken: string | null;
      chatgptAccountId: string | null;
      lastRefresh: string | null;
    };
  };
  const src = payload.source;
  const existing = job.accountId ? repo.getAccountById(job.accountId) : undefined;
  const now = new Date().toISOString();

  if (payload.action === "upgrade_recovered") {
    // Sub2API 远端已经有这账号，只需要：(a) 回填 codex-tool 给的凭据，(b) 升级 origin
    const encPhone = crypto.encryptOptional(src.phone);
    const encPassword = crypto.encryptOptional(src.password);
    const encRefresh = src.refreshToken ? crypto.encryptOptional(src.refreshToken) : null;
    if (existing) {
      repo.patchAccount(existing.id, {
        externalId: payload.sub2apiAccountId,
        origin: "adopted_recovered",
        intent: "active",
        health: "healthy",
        encPhone,
        encPassword,
        ...(encRefresh ? { encRefreshToken: encRefresh } : {}),
        ...(src.batchId ? { batchId: src.batchId } : {}),
        lastRecoveryError: null,
        lastRecoveryFailureCategory: null,
        recoveryAttempts: 0,
        nextRecoveryAfter: null,
        // P5-AQ: 缺首见时间的旧记录用 codex-tool created_at 回填
        ...(!existing.firstSeenAt && src.createdAt ? { firstSeenAt: src.createdAt } : {})
      });
    } else {
      // 本地完全没记录，新建一条
      const fresh = makeFreshAccount({
        externalId: payload.sub2apiAccountId,
        email: src.email ?? `codex-${src.id}@adopted.local`,
        origin: "adopted_recovered",
        intent: "active",
        health: "healthy",
        encPhone,
        encPassword,
        encRefreshToken: encRefresh,
        batchId: src.batchId,
        registeredAt: src.lastRefresh ?? now,
        // P5-AQ: 首见时间优先用 codex-tool 端 created_at（账号真实出生时间）
        firstSeenAt: src.createdAt ?? src.lastRefresh ?? now
      });
      repo.upsertAccount(fresh);
    }
    return;
  }

  if (payload.action === "register_new") {
    if (!src.refreshToken) {
      throw new Error("register_new 路径要求 codex-tool 给的 refresh_token 存在（与 plan 不一致）");
    }
    // 复用 import_to_sub2api 流程：refresh → create → 落 Hive。本路径不走 codex-tool spawn，
    // proxy_id 用 spec.intake 兜底（codex-tool 出口节点信息 Hive 这边没有）。
    const proxyId = resolveCreationProxyId(repo, null);
    const sub2api = requireSub2apiClient(repo);
    const refreshed = await sub2api.refreshOpenaiToken({ refreshToken: src.refreshToken, proxyId });
    const created = await sub2api.createAccount(
      makeCreatePayload({
        spec,
        proxyId,
        tokens: {
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token,
          idToken: refreshed.id_token
        },
        email: refreshed.email,
        organizationId: refreshed.organization_id,
        clientId: refreshed.client_id,
        expiresAt: refreshed.expires_at,
        name: synthesizeName(spec, refreshed.email)
      })
    );
    const fresh = makeFreshAccount({
      externalId: created.id,
      email: refreshed.email,
      organizationId: refreshed.organization_id,
      clientId: refreshed.client_id,
      origin: "hive_registered", // 接管自 codex-tool 注册的账号 → 视作 hive_registered
      intent: "active",
      health: "healthy",
      encPhone: crypto.encryptOptional(src.phone),
      encPassword: crypto.encryptOptional(src.password),
      encRefreshToken: crypto.encryptOptional(refreshed.refresh_token),
      batchId: src.batchId,
      registeredAt: src.lastRefresh ?? now,
      firstSeenAt: src.createdAt ?? src.lastRefresh ?? now,
      lastRecoveryPath: null
    });
    repo.upsertAccount(fresh);
    return;
  }

  // observed_only：codex-tool 知道凭据但没活的 refresh_token，Sub2API 也没绑。
  // 落 Hive observed-only —— 不调 Sub2API、不入 codex_login 队列；用户在 UI 上手动
  // 触发一次 codex_login 即可救活（会用我们回填的 phone+password）。
  const encPhone = crypto.encryptOptional(src.phone);
  const encPassword = crypto.encryptOptional(src.password);
  if (existing) {
    repo.patchAccount(existing.id, {
      origin: "adopted_observing",
      intent: "active",
      health: "unknown",
      encPhone,
      encPassword,
      ...(src.batchId ? { batchId: src.batchId } : {}),
      // P5-AQ: 缺首见时间的旧记录用 codex-tool created_at 回填
      ...(!existing.firstSeenAt && src.createdAt ? { firstSeenAt: src.createdAt } : {})
    });
  } else {
    const fresh = makeFreshAccount({
      email: src.email ?? `codex-${src.id}@adopted.local`,
      origin: "adopted_observing",
      intent: "active",
      health: "unknown",
      encPhone,
      encPassword,
      batchId: src.batchId,
      registeredAt: src.lastRefresh ?? now,
      firstSeenAt: src.createdAt ?? src.lastRefresh ?? now
    });
    repo.upsertAccount(fresh);
  }
}

async function runDeleteSub2api(repo: HiveRepository, _spec: AccountFleetSpec, job: AccountJob): Promise<void> {
  const account = job.accountId ? repo.getAccountById(job.accountId) : undefined;
  if (!account || !account.externalId) throw new Error("delete_sub2api requires account with externalId");
  const sub2api = requireSub2apiClient(repo);
  await sub2api.deleteAccount(account.externalId);
  // 本地标 retired_legacy，保留审计
  repo.patchAccount(account.id, {
    origin: "retired_legacy",
    intent: "retired",
    externalId: null
  });
}

async function runToggleSchedulable(
  repo: HiveRepository,
  _spec: AccountFleetSpec,
  job: AccountJob
): Promise<void> {
  const account = job.accountId ? repo.getAccountById(job.accountId) : undefined;
  if (!account || !account.externalId) throw new Error("toggle_schedulable requires account with externalId");
  const payload = JSON.parse(job.payloadJson) as { schedulable: boolean };
  const sub2api = requireSub2apiClient(repo);
  await sub2api.setAccountSchedulable(account.externalId, payload.schedulable);
}

async function runObserveUsage(repo: HiveRepository, _spec: AccountFleetSpec, job: AccountJob): Promise<void> {
  const account = job.accountId ? repo.getAccountById(job.accountId) : undefined;
  if (!account || !account.externalId) throw new Error("observe_usage requires account with externalId");
  const sub2api = requireSub2apiClient(repo);
  const usage = await sub2api.getAccountUsage(account.externalId);
  repo.patchAccount(account.id, {
    quota5hPercent: Math.round((usage.five_hour.utilization ?? 0) * 100),
    quota7dPercent: Math.round((usage.seven_day.utilization ?? 0) * 100),
    lastObservedAt: new Date().toISOString()
  });
}

// ─── 内部工具 ────────────────────────────────────

interface LandOnSub2apiInput {
  repo: HiveRepository;
  crypto: AccountCrypto;
  spec: AccountFleetSpec;
  account?: AccountRecordInternal | undefined;
  tokens: { idToken: string; accessToken: string; refreshToken: string };
  email: string;
  organizationId?: string | null | undefined;
  clientId?: string | null | undefined;
  accountIdHint?: string | null | undefined;
  phone?: string | undefined;
  password?: string | undefined;
  batchId?: string | undefined;
  isRecovery?: boolean | undefined;
  isFreshRegistration?: boolean | undefined;
  /** 本次 codex-tool 调用用了哪个本地节点作出口；落地账号时写入 egressNodeHash 作软粘性 */
  egressNodeHash?: string | null | undefined;
  /** P5-AI: codex-tool 注册返回的 sms_country；非注册路径（恢复登录 / import）为 null */
  smsCountry?: string | null | undefined;
  /** P5-AI: codex-tool 注册返回的 sms_cost_usd * 100；非注册路径为 null */
  smsCostCents?: number | null | undefined;
  /** hero-sms 激活 ID（登录 step-up 重激活二次接码用）；仅新注册路径有。 */
  herosmsActivationId?: string | null | undefined;
}

/**
 * 把 fresh tokens 灌进 Sub2API（refresh-token + createAccount），
 * 并更新本地 accounts 表（旧账号 origin=adopted_recovered 或新账号 hive_registered）。
 *
 * 若 spec.recovery.deleteOldAccountOnRecovery=true 且旧账号有 externalId →
 * 创建新 Sub2API record 成功后删除旧的。
 */
/**
 * 对 Sub2API 落地的**瞬时错误**(5xx / EOF / 网络抖动 / OpenAI 上游临时失败)有界重试。
 * 背景:刚注册拿到的 token 是有效的,但 Sub2API 替我们验 token 时偶发 502
 * (OPENAI_OAUTH_REQUEST_FAILED: EOF)——若不重试就把这个号连同接码费白白丢掉。
 * 仅对瞬时错误重试;4xx/配置类等确定性错误立即抛出。
 */
async function withSub2apiRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      const transient =
        msg.includes("500") ||
        msg.includes("502") ||
        msg.includes("503") ||
        msg.includes("504") ||
        msg.includes("eof") ||
        msg.includes("timeout") ||
        msg.includes("timed out") ||
        msg.includes("econn") ||
        msg.includes("socket") ||
        msg.includes("network") ||
        msg.includes("openai_oauth_request_failed") ||
        msg.includes("upstream");
      if (!transient || i >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1500 * 2 ** (i - 1), 8000)));
    }
  }
  throw lastErr;
}

async function landOnSub2api(input: LandOnSub2apiInput): Promise<void> {
  const { repo, crypto, spec, account, tokens, email } = input;
  const sub2api = requireSub2apiClient(repo);
  // 1. 推导 Sub2API 端的 proxy_id ——
  //    优先用本次 codex-tool 实际走的节点对应的 Sub2API proxy_id（egress 节点必须先
  //    "启用调度"推到 Sub2API 才有此映射）。这样账号 IP 出生地跟 Sub2API 看到的
  //    binding 一致，省一次后续 reconcile 漂移。
  //    fallback：代理编排 Spec.intake.proxyId（如果配过 intake 兜底代理）。
  //    两者都没 → 抛错，让用户感知问题（而不是硬编码到某个不知名 proxy_id=1）。
  const proxyId = resolveCreationProxyId(repo, input.egressNodeHash ?? null);
  // 2. 灌 token 到 Sub2API → 拿标准化 token bundle（含 client_id / org_id / expires_at）
  //    Sub2API 这步会替我们调 OpenAI /oauth/token 验 token，偶发 502/EOF（Sub2API↔OpenAI
  //    瞬时网络抖动，OPENAI_OAUTH_REQUEST_FAILED）。**必须重试**——否则刚注册拿到的有效
  //    token 因一次网络抖动就被丢、白白浪费一个注册号 + 接码费（实测复现）。
  const refreshed = await withSub2apiRetry(() =>
    sub2api.refreshOpenaiToken({ refreshToken: tokens.refreshToken, proxyId })
  );
  // 3. POST /admin/accounts（同样对瞬时错误重试）
  const name = synthesizeName(spec, email);
  const created = await withSub2apiRetry(() =>
    sub2api.createAccount(
      makeCreatePayload({
        spec,
        proxyId,
        tokens: { accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token, idToken: refreshed.id_token },
        email: refreshed.email,
        organizationId: refreshed.organization_id,
        clientId: refreshed.client_id,
        expiresAt: refreshed.expires_at,
        name
      })
    )
  );
  // 3. 删除旧 Sub2API 记录（可选）
  let deletedOld = false;
  if (input.isRecovery && account?.externalId && spec.recovery.deleteOldAccountOnRecovery) {
    try {
      await sub2api.deleteAccount(account.externalId);
      deletedOld = true;
    } catch (err) {
      console.warn(`failed to delete old Sub2API account ${account.externalId}:`, err);
    }
  }
  // 4. 本地账号更新
  const now = new Date().toISOString();
  if (account) {
    repo.patchAccount(account.id, {
      externalId: created.id,
      origin: account.origin === "hive_registered" ? "hive_registered" : "adopted_recovered",
      intent: "active",
      health: "healthy",
      encRefreshToken: crypto.encryptOptional(refreshed.refresh_token),
      encAccessToken: null, // 短期：不长期持有
      encIdToken: null,
      organizationId: refreshed.organization_id,
      clientId: refreshed.client_id,
      lastObservedAt: now,
      recoveryAttempts: 0,
      nextRecoveryAfter: null,
      lastRecoveryError: deletedOld ? null : account.lastRecoveryError,
      lastRecoveryPath: "codex_login",
      // 恢复成功后清掉上次失败分类（让 UI 不再显示旧的红色告警）
      lastRecoveryFailureCategory: null,
      // P5-AQ: codex_login 修复成功 = 一次重新登录，单调累加 + 记录时间。
      // recoveryAttempts 已在上面清零（那是"当前连续尝试"），reloginCount 是"历史总重登次数"。
      ...(input.isRecovery
        ? { reloginCount: (account.reloginCount ?? 0) + 1, lastRecoveredAt: now }
        : {}),
      // 仅在本次成功用过 egress 时回填；保留原值的 fallback：传 null 会覆盖，传 undefined 会跳过
      ...(input.egressNodeHash !== undefined ? { egressNodeHash: input.egressNodeHash } : {})
    });
  } else if (input.isFreshRegistration) {
    const fresh = makeFreshAccount({
      externalId: created.id,
      email: refreshed.email,
      organizationId: refreshed.organization_id,
      clientId: refreshed.client_id,
      origin: "hive_registered",
      intent: "active",
      health: "healthy",
      encPhone: input.phone ? crypto.encryptOptional(input.phone) : null,
      encPassword: input.password ? crypto.encryptOptional(input.password) : null,
      encRefreshToken: crypto.encryptOptional(refreshed.refresh_token),
      batchId: input.batchId ?? null,
      registeredAt: now,
      lastRecoveryPath: "codex_register",
      egressNodeHash: input.egressNodeHash ?? null,
      smsCountry: input.smsCountry ?? null,
      smsCostCents: input.smsCostCents ?? null,
      herosmsActivationId: input.herosmsActivationId ?? null
    });
    repo.upsertAccount(fresh);
  }
}

function makeCreatePayload(input: {
  spec: AccountFleetSpec;
  proxyId: number;
  tokens: { accessToken: string; refreshToken: string; idToken: string };
  email: string;
  organizationId: string;
  clientId: string;
  expiresAt: number;
  name: string;
}): Sub2ApiCreateAccountPayload {
  return {
    name: input.name,
    notes: input.spec.target.naming.notes,
    platform: "openai",
    type: "oauth",
    credentials: {
      access_token: input.tokens.accessToken,
      refresh_token: input.tokens.refreshToken,
      id_token: input.tokens.idToken,
      expires_at: input.expiresAt,
      client_id: input.clientId,
      email: input.email,
      organization_id: input.organizationId,
      model_mapping: {}
    },
    extra: { email: input.email },
    proxy_id: input.proxyId,
    concurrency: 10,
    priority: 1,
    rate_multiplier: 1,
    group_ids: input.spec.registration.autoAssignGroupIds,
    expires_at: null,
    auto_pause_on_expired: true
  };
}

/**
 * 推导 Sub2API 端 createAccount 用的 proxy_id。
 *
 * 优先级（高 → 低）：
 *   1. egress 节点对应的 Sub2API proxy_id（node.sub2apiProxyId）
 *      —— 账号编排走的本地代理跟新账号在 Sub2API 端的初始 binding 一致
 *   2. 代理编排 Spec.intake.proxyId （OrchestrationSpec 的 intake 配置）
 *      —— 用户在代理编排页配过的"新账号兜底入口"
 *   3. 都没有 → 抛错。**不再硬编码 default proxy_id**。
 *
 * 没有兜底是设计选择：用户必须有一个明确的"账号该绑哪个 proxy"的源头，
 * 要么是节点池里的健康节点（推过 Sub2API），要么是代理编排里手动选的 intake。
 * 不允许"凭空数字 id"——避免新账号被绑到一个用户压根不知道的代理上。
 */
function resolveCreationProxyId(repo: HiveRepository, egressNodeHash: string | null): number {
  if (egressNodeHash) {
    const node = repo.listNodes().find((n) => n.hash === egressNodeHash);
    if (node?.sub2apiProxyId) return node.sub2apiProxyId;
  }
  const orch = repo.getOrchestrationSpec();
  if (orch.intake.proxyId) return orch.intake.proxyId;
  throw new Error(
    "无法确定新账号 Sub2API proxy_id：" +
      "egress 节点未推到 Sub2API（先在节点池启用调度），且代理编排页 intake.proxyId 也未配置。"
  );
}

function makeFreshAccount(overrides: Partial<AccountRecordInternal>): AccountRecordInternal {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    externalId: null,
    origin: "hive_registered",
    intent: "active",
    health: "healthy",
    email: "unknown@local",
    organizationId: null,
    clientId: null,
    platform: "openai",
    type: "oauth",
    encPhone: null,
    encPassword: null,
    encRefreshToken: null,
    encAccessToken: null,
    encIdToken: null,
    encRecoveryInputJson: null,
    lastObservedAt: now,
    lastUsedAt: null,
    rateLimitedAt: null,
    rateLimitResetAt: null,
    quota5hPercent: null,
    quota7dPercent: null,
    errorsInWindow: 0,
    brokenSinceTick: null,
    brokenConsecutiveTicks: 0,
    recoveryAttempts: 0,
    nextRecoveryAfter: null,
    lastRecoveryError: null,
    lastRecoveryPath: null,
    lastRecoveryFailureCategory: null,
    opsEnabled: true,
    herosmsActivationId: null,
    batchId: null,
    registeredAt: null,
    smsCountry: null,
    smsCostCents: null,
    egressNodeHash: null,
    firstSeenAt: now,
    reloginCount: 0,
    lastRecoveredAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function synthesizeName(spec: AccountFleetSpec, email: string): string {
  const tmpl = spec.target.naming.template;
  const date = new Date().toISOString().slice(2, 10).replace(/-/g, ""); // YYMMDD
  const seqRand = Math.random().toString(36).slice(2, 6);
  return tmpl
    .replace("{date}", date)
    .replace("{seq}", seqRand)
    .replace("{email}", email);
}

/**
 * 按错误消息字符串分类 codex 修复失败（P5-AP）。
 *
 * 为什么不用 codex-tool 的 failure_category：实测 codex-tool 这些失败多以非零退出码 /
 * 超时抛出，被 runEnvelope 当 CodexToolError 抛，绕过了 {kind:failed} 信封分类，
 * 所以 Hive 拿不到 failure_category（实测 323 账号 category 全 null）。改为 Hive 侧
 * 按消息 marker 自己判（marker 取自 codex-tool 的 _oauth_failure_details + 补 Sentinel）。
 *
 *   account_unusable —— 仅明确的账号级吊销（revoked / invalidated oauth）：账号废了，退役不重试。
 *   network_or_proxy —— 超时/代理/连接/TLS/Sentinel 提取失败 + OAuth 跳转链缺少目标 URL/code
 *                       （多为出口 IP 被质询）：换个出口重试就可能成功，不该算账号的错、不轻易退役。
 *   oauth_failed     —— 其它 OAuth 失败：按常规退避，达上限退役。
 */
/**
 * 注册失败归因（P5-AX）。codex-tool 的注册失败大多是接码侧问题，归成人话：
 *   - 取不到号(NO_NUMBERS/没有可用号码/取号失败) 与 取到号收不到验证码('timeouts'/
 *     验证码超时) —— 用户明确：两者都属"地区不可用"，换地区/稍后重试可能就好，
 *     不是账号或节点的问题。
 *   - 余额不足 —— 接码平台没钱了。
 *   - 其它 —— 原样带出，至少标成注册失败。
 */
export function describeRegistrationFailure(error: string, attemptCount: number): string {
  const e = (error || "").toLowerCase();
  const suffix = attemptCount > 0 ? `（已尝试 ${attemptCount} 个地区/号码）` : "";
  const regionMarkers = [
    "timeout", // 'timeouts' 等待验证码超时
    "no_numbers",
    "no numbers",
    "没有可用号码",
    "取号失败",
    "无可用",
    "otp",
    "验证码"
  ];
  // P7：被预算/SIGTERM 优雅中止(超时但已保留地区经验)
  if (e.includes("中止") || e.includes("budget_exceeded") || e.includes("sigterm") || e.includes("abort")) {
    return `注册超时中止（已保留地区经验，下次跳过坏区）${suffix}`;
  }
  if (regionMarkers.some((k) => e.includes(k))) {
    return `地区不可用（取不到号或收不到验证码）${suffix}`;
  }
  if (e.includes("余额") || e.includes("balance") || e.includes("insufficient")) {
    return `接码平台余额不足${suffix}`;
  }
  return `注册失败：${error}${suffix}`;
}

export function classifyCodexFailure(message: string): "account_unusable" | "network_or_proxy" | "oauth_failed" {
  const m = message.toLowerCase();
  // 终态废账号标记 —— 只认"明确的账号级吊销/失效"信号（Sub2API 报 token revoked /
  // invalidated oauth token：授权已被吊销，反复重登/刷新都救不回，直接退役不空转）。
  if (
    m.includes("account_unusable") ||
    m.includes("revoked") ||
    m.includes("invalidated oauth") ||
    // OpenAI 明确"账号已删除/停用"——实测大量 recovering 账号是被封停的(email-otp/validate
    // 返回 403 + "deleted or deactivated")。这类账号反复重登也救不回,直接退役。
    m.includes("deleted or deactivated") ||
    m.includes("deactivated") ||
    m.includes("do not have an account")
  ) {
    return "account_unusable";
  }
  // P5-BA 根因修复：OAuth 跳转链"缺少目标 URL / 缺少 continue_url / 没有 code"过去被当
  // account_unusable 直接退役 —— 但实测这绝大多数是"出口 IP 被 OpenAI 质询"（authorize
  // 返回质询页而非 302 跳转），不是账号死了。手动经干净代理(Clash)重登就成功。归
  // network_or_proxy：清出口软粘性 → 换节点重试（cap = maxAttempts×3），而不是一次质询就杀号。
  if (m.includes("缺少目标") || m.includes("missing target url") || m.includes("没有 code")) {
    return "network_or_proxy";
  }
  // P5-AX：地区不可用（取不到号/收不到验证码）也算可重试的瞬时类，不退役账号
  const regionMarkers = ["地区不可用", "取不到号", "收不到验证码", "no_numbers", "没有可用号码"];
  if (regionMarkers.some((k) => m.includes(k))) return "network_or_proxy";
  const networkMarkers = [
    "timed out", "timeout", "curl", "代理", "proxy", "connection", "connect",
    "tls", "ssl", "network", "网络", "sentinel", "环境校验", "econn", "socket"
  ];
  if (networkMarkers.some((k) => m.includes(k))) return "network_or_proxy";
  return "oauth_failed";
}

/**
 * P5-AS: 把一次 codex_login/register 经某节点出口的实战结果回写到节点。
 * 失败仅在 network_or_proxy（含 Sentinel）类时记账 —— account_unusable / oauth_failed
 * 是账号自身问题，不该污染节点的"能否过 Sentinel"信誉。egress 为 null（egress.mode=none）
 * 时 no-op。
 */
/** 把 egress 选择渲染成"节点名 (原因)"给日志用，找不到名字就用 hash 前 8 位。 */
function egressLabel(repo: HiveRepository, egress: EgressSelection): string {
  const node = repo.listNodes().find((n) => n.hash === egress.hash);
  const name = node?.name ?? egress.hash.slice(0, 8);
  const tag = egress.reserved ? "保留" : egress.reason;
  return `${name} [${tag}]`;
}

/** job 日志里的"出口"行。动态出口关闭时,真实出口是 agent 本机配置的代理(如 192.168.5.8),
 * 选中的节点只作记录、并不生效——所以别再打成"选定出口节点 XX"误导以为在走机房节点。 */
function egressLogLine(repo: HiveRepository, spec: AccountFleetSpec, egress: EgressSelection | null): string {
  if (!codexEgressRuntime(spec).enabled) {
    return egress
      ? `出口：agent 本机直连(动态出口关闭;选节点 ${egressLabel(repo, egress)} 仅记录、未启用)`
      : "出口：agent 本机直连(动态出口关闭)";
  }
  return egress ? `选定出口节点 ${egressLabel(repo, egress)}` : "未走本地出口（egress=none）";
}

function recordNodeOutcome(
  repo: HiveRepository,
  egress: EgressSelection | null,
  result: "success" | { failedMessage: string },
  kind: "login" | "register"
): void {
  if (!egress) return;
  if (result === "success") {
    repo.recordNodeCodexOutcome(egress.hash, "success", kind);
    return;
  }
  if (classifyCodexFailure(result.failedMessage) === "network_or_proxy") {
    repo.recordNodeCodexOutcome(egress.hash, "failure", kind);
  }
}

function applyRecoveryFailure(
  repo: HiveRepository,
  spec: AccountFleetSpec,
  job: AccountJob,
  message: string
): void {
  if (!job.accountId) return;
  const account = repo.getAccountById(job.accountId);
  if (!account) return;
  const category = classifyCodexFailure(message);
  const path = job.kind === "codex_login" ? "codex_login" : "codex_register";
  const redacted = redactErrorMessage(message);

  // account_unusable：账号 OAuth 链终态废了，直接退役、不再消耗修复配额。
  if (category === "account_unusable") {
    repo.patchAccount(account.id, {
      intent: "retired",
      health: "broken",
      lastRecoveryError: redacted,
      lastRecoveryPath: path,
      lastRecoveryFailureCategory: "account_unusable"
    });
    // P5-AV：取消该账号残留的 queued job，别让重复任务继续死磕已退役的死账号、
    // 把宝贵的串行 codex-tool 槽位让给其它账号。
    const cancelled = repo.cancelQueuedJobsForAccount(account.id, "account_unusable，已退役");
    if (cancelled > 0) {
      console.log(`applyRecoveryFailure: 账号 ${account.id} 不可用退役，取消 ${cancelled} 个残留 queued job。`);
    }
    return;
  }

  const attempts = account.recoveryAttempts + 1;
  const backoffIdx = Math.min(attempts - 1, spec.recovery.backoffSequenceMs.length - 1);
  const backoffMs = spec.recovery.backoffSequenceMs[backoffIdx] ?? 60_000;

  // network_or_proxy：代理/网络/出口/Sentinel/consent 类失败**不是账号的错** ——
  // 永不退役。退役(retired)从此只表示"OpenAI 确认死号(account_unusable)"这一终态,
  // 不再把"我方出口过不了 consent"的活账号当死号丢掉(实测大量被误退役的活账号)。
  // 保持 recovering，退避按 backoffSequenceMs 升到封顶(默认 6h)：账号留着、极少重试，
  // 等出口/consent 修好后能自动救回。清出口软粘性 → 下次重新加权选别的出口。
  if (category === "network_or_proxy") {
    repo.patchAccount(account.id, {
      recoveryAttempts: attempts,
      nextRecoveryAfter: new Date(Date.now() + backoffMs).toISOString(),
      lastRecoveryError: redacted,
      lastRecoveryPath: path,
      lastRecoveryFailureCategory: "network_or_proxy",
      egressNodeHash: null,
      intent: "recovering"
    });
    return;
  }

  // oauth_failed：常规退避，达 maxAttemptsPerAccount 退役。
  repo.patchAccount(account.id, {
    recoveryAttempts: attempts,
    nextRecoveryAfter: new Date(Date.now() + backoffMs).toISOString(),
    lastRecoveryError: redacted,
    lastRecoveryPath: path,
    lastRecoveryFailureCategory: "oauth_failed",
    intent: attempts >= spec.recovery.maxAttemptsPerAccount ? "retired" : "recovering"
  });
}

/**
 * 记账（P6-09 修正）：
 *   deltaRegistrations —— **仅成功注册(token_ready)计 1**，失败尝试不计入"今日注册"
 *     额度。否则一串失败会把 dailyBudget 烧光，永久拦截自动注册（实测 25 次尝试只 5
 *     成功却把 used 顶到 25、dailyBudget=1 直接锁死）。
 *   deltaSmsCostCents —— 任何实际取号花费都记（含失败时已扣的号费），成本真实反映。
 */
function incrementRegistrationsBudget(
  repo: HiveRepository,
  spec: AccountFleetSpec,
  opts: { deltaRegistrations: number; deltaSmsCostCents: number }
): void {
  const now = new Date();
  const dayKey = budgetWindowKey(now, "day");
  const monthKey = budgetWindowKey(now, "month");
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  const monthAfter = new Date(now);
  monthAfter.setUTCMonth(monthAfter.getUTCMonth() + 1);
  monthAfter.setUTCDate(1);
  monthAfter.setUTCHours(0, 0, 0, 0);
  repo.incrementBudgetUsage({
    windowKey: dayKey,
    registrationsBudget: spec.registration.dailyBudget,
    resetAt: tomorrow.toISOString(),
    deltaRegistrations: opts.deltaRegistrations,
    deltaSmsCostCents: opts.deltaSmsCostCents
  });
  repo.incrementBudgetUsage({
    windowKey: monthKey,
    registrationsBudget: spec.registration.monthlyBudget,
    resetAt: monthAfter.toISOString(),
    deltaRegistrations: opts.deltaRegistrations,
    deltaSmsCostCents: opts.deltaSmsCostCents
  });
}

export async function buildCodexToolAdapter(
  repo: HiveRepository,
  crypto: AccountCrypto,
  spec: AccountFleetSpec,
  /**
   * 由调用方（register / login / import handler）按场景选好的 egress；null 表示
   * 调用方不需要走出口（如 codex sms countries 之类纯查询，但当前实现总传 egress）。
   */
  egress: EgressSelection | null,
  opts?: { idempotencyKey?: string }
): Promise<CodexToolAdapter> {
  // P5-AM: codexTool.skymail.adminPasswordRef / phoneSms.apiKeyRef 按设计是「明文存储」
  // （docs：私有部署 UI 不脱敏，加密留作未来增强）。早期代码无脑 crypto.decrypt() 会把
  // 明文当密文解析 → "Malformed ciphertext: expected 4 parts, got 1"。
  // readMaybeEncrypted：只有 4 段 VERSION:iv:tag:ct 格式才尝试解密，否则按明文返回，
  // 兼容"明文存储"与"未来加密存储"两种形态。
  const skymailPassword = readMaybeEncrypted(crypto, spec.codexTool.skymail.adminPasswordRef);
  const smsApiKey = readMaybeEncrypted(crypto, spec.codexTool.phoneSms.apiKeyRef);

  // 外置 agent 模式：spawner 改走 HTTP（桌面真实 OS 跑浏览器）；出口走 Mihomo 单口动态组。
  const agentCfg = spec.codexTool.remoteAgent;
  const agentMode = Boolean(agentCfg?.enabled && agentCfg.url);
  const ce = codexEgressRuntime(spec);
  let spawner: CodexToolSpawner | undefined;
  let proxyDefault: string;
  if (agentMode) {
    const agentToken = readMaybeEncrypted(crypto, agentCfg.tokenRef);
    spawner = createAgentSpawner({
      url: agentCfg.url,
      token: agentToken,
      ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      timeoutPaddingMs: agentCfg.requestTimeoutPaddingMs
    });
    // dynamic：固定指向 Mihomo 唯一鉴权口，真实出口由 applyCodexEgress 切组决定；
    // 否则空代理 → agent 用其所在桌面自身网络（如透明 OpenClash）出去。
    proxyDefault = ce.enabled ? `http://${ce.user}:${ce.pass}@${ce.host}:${ce.port}` : "";
  } else {
    // P5-AP: 必须用 http:// 而非 socks5:// —— mihomo listener 是 mixed(http+socks)。
    // 实测 socks5:// 走"本地 DNS"(容器本地把域名解析成 IP 再发给代理)，代理出口连不上
    // 那个 IP → 全部超时(codex_login 0 成功)。http:// 代理走"远程 DNS"(代理自己解析)，
    // curl + chromium 都正常通(实测 gstatic 204 / auth.openai.com 403 reached)。
    proxyDefault = egress ? `http://127.0.0.1:${egress.port}` : resolveLegacyEgressProxyUrl(repo, spec);
  }
  // P5-AI: 透明回灌 region_hint —— 上次注册成功的 sms_region_result blob 原样塞给
  // codex-tool 让它优先尝试该地区，Hive 不解析 blob 字段。第一次跑时没有，为 null。
  const hintMemory = repo.getSmsRegionHint();
  const config: CodexToolConfig = {
    binPath: spec.codexTool.binPath,
    skymail: {
      baseUrl: spec.codexTool.skymail.baseUrl,
      adminEmail: spec.codexTool.skymail.adminEmail,
      adminPassword: skymailPassword
    },
    chatgpt: {
      mailDomain: spec.codexTool.chatgpt.mailDomain,
      chatWebClientId: spec.codexTool.chatgpt.chatWebClientId,
      codexClientId: spec.codexTool.chatgpt.codexClientId
    },
    phoneSms: {
      provider: spec.codexTool.phoneSms.provider,
      apiKey: smsApiKey,
      service: spec.codexTool.phoneSms.service,
      maxCostPerAccountUsd: spec.registration.maxCostPerAccountUsd,
      ...(hintMemory?.hint != null ? { regionHint: hintMemory.hint } : {})
    },
    httpUserAgentChrome: spec.codexTool.httpUserAgentChrome,
    proxyDefault
  };
  return createCodexToolAdapter({
    config,
    defaults: {
      smsCountriesMs: spec.codexTool.timeouts.smsCountriesMs,
      loginMs: spec.codexTool.timeouts.loginMs,
      registerMs: spec.codexTool.timeouts.registerMs
    },
    ...(spawner ? { spawner } : {})
  });
}

/**
 * 动态出口：external agent + codexEgress.dynamic 开启时,把 Mihomo 的 codex-egress select 组
 * 切到本次选定的节点。远程 codex-tool 经 Mihomo 唯一鉴权口出去时即走该节点。串行段内调用。
 * 切组失败抛错（中止本次,别拿错出口跑）。非 dynamic / 无 egress → no-op。
 */
async function applyCodexEgress(
  config: RuntimeConfig,
  spec: AccountFleetSpec,
  egress: EgressSelection | null,
  jobId: string
): Promise<void> {
  const ce = codexEgressRuntime(spec);
  if (!ce.enabled || !egress) return;
  const proxyName = proxyNameForNode({ hash: egress.hash, assignedPort: egress.port });
  await setProxyGroupSelection(config, "codex-egress", proxyName);
  appendJobLog(jobId, `出口切到 ${proxyName}（codex-egress）`);
}

/**
 * 外置 agent 调用前探活。不健康 → 抛 NoEgressAvailableError（被 executor 当"基础设施暂时
 * 不可用",不计 recoveryAttempts、不烧账号/注册额度,下个 tick 再试）。未启用 agent → no-op。
 */
async function assertAgentHealthy(crypto: AccountCrypto, spec: AccountFleetSpec): Promise<void> {
  const agentCfg = spec.codexTool.remoteAgent;
  if (!agentCfg?.enabled || !agentCfg.url || !agentCfg.healthCheck) return;
  const token = readMaybeEncrypted(crypto, agentCfg.tokenRef);
  const ok = await isAgentHealthy(agentCfg.url, token);
  if (!ok) {
    throw new NoEgressAvailableError(`codex-tool agent 不可达：${agentCfg.url}（本轮跳过，等 agent 恢复）`);
  }
}

/**
 * 在 spec.codexTool.egress.mode === 'pinned-node' / 'none' 时兜底走的旧选择逻辑。
 *
 * managed-node 模式现在已被 register/login handler 显式调用 selectEgressForRegister
 * / selectEgressForLogin 取代，所以这里只处理 pinned / none 两种简单 mode；
 * 走到 managed-node 分支说明调用方没主动选 egress，保留原"取第一个候选"行为。
 */
function resolveLegacyEgressProxyUrl(repo: HiveRepository, spec: AccountFleetSpec): string {
  const mode = spec.codexTool.egress.mode;
  if (mode === "none") return "";
  if (mode === "pinned-node" && spec.codexTool.egress.pinnedNodeHash) {
    const node = repo.listNodes().find((n) => n.hash === spec.codexTool.egress.pinnedNodeHash);
    if (!node?.assignedPort) {
      throw new Error(
        `egress pinned node ${spec.codexTool.egress.pinnedNodeHash} not found or has no assigned port`
      );
    }
    return `http://127.0.0.1:${node.assignedPort}`;
  }
  // 兜底：第一个可用节点（保守，跟 P4 旧行为兼容）
  const candidates: ProxyNode[] = repo
    .listNodes()
    .filter((n) => n.schedulable && n.status === "active" && n.assignedPort);
  const pick = candidates[0];
  if (!pick?.assignedPort) {
    throw new Error("no healthy + schedulable + ported node available for egress");
  }
  return `http://127.0.0.1:${pick.assignedPort}`;
}

/**
 * 注册（codex_register / import_to_sub2api）—— 按质量+负载加权随机。
 *
 * pinned-node mode 仍优先；none mode 返回 null（adapter 接受 null=不走代理）。
 */
function resolveEgressForRegister(repo: HiveRepository, spec: AccountFleetSpec): EgressSelection | null {
  if (spec.codexTool.egress.mode === "none") return null;
  if (spec.codexTool.egress.mode === "pinned-node" && spec.codexTool.egress.pinnedNodeHash) {
    const node = repo.listNodes().find((n) => n.hash === spec.codexTool.egress.pinnedNodeHash);
    if (!node?.assignedPort) {
      throw new NoEgressAvailableError(
        `pinned egress node ${spec.codexTool.egress.pinnedNodeHash} not found / no assigned port`
      );
    }
    return { hash: node.hash, port: node.assignedPort, reason: "preferred" };
  }
  // managed-node 默认路径
  const nodes = repo.listNodes();
  const loads = buildEgressLoadMap(repo.listAccounts());
  return selectEgressForRegister({ nodes, egressLoadByNodeHash: loads });
}

/**
 * 登录（codex_login）—— 优先 account.egressNodeHash 软粘性，
 * 不可用则等同 resolveEgressForRegister。
 */
function resolveEgressForLogin(
  repo: HiveRepository,
  spec: AccountFleetSpec,
  account: AccountRecordInternal
): EgressSelection | null {
  if (spec.codexTool.egress.mode === "none") return null;
  if (spec.codexTool.egress.mode === "pinned-node" && spec.codexTool.egress.pinnedNodeHash) {
    return resolveEgressForRegister(repo, spec);
  }
  const nodes = repo.listNodes();
  const loads = buildEgressLoadMap(repo.listAccounts());
  return selectEgressForLogin({
    nodes,
    egressLoadByNodeHash: loads,
    preferredHash: account.egressNodeHash
  });
}

function requireSub2apiClient(repo: HiveRepository): Sub2ApiClient {
  const conn = repo.getSub2ApiConnection();
  if (!conn) throw new Error("Sub2API connection not configured");
  return createSub2ApiClient(conn);
}

/**
 * 读取「可能加密、也可能是明文」的 secret 字段（P5-AM）。
 * codexTool 的 adminPasswordRef / apiKeyRef 按当前设计明文存储，但字段名带 Ref
 * 暗示未来可能加密。AccountCrypto 密文格式是 4 段 `VERSION:iv:tag:ct`，明文几乎
 * 不可能恰好命中。所以：4 段才尝试 decrypt（失败回退明文），否则直接当明文。
 */
function readMaybeEncrypted(crypto: AccountCrypto, value: string | null | undefined): string {
  if (!value) return "";
  if (value.split(":").length === 4) {
    try {
      return crypto.decrypt(value);
    } catch {
      return value; // 看着像密文但解不开 → 当明文兜底，不阻断
    }
  }
  return value;
}

export function safeLoadCrypto(): AccountCrypto {
  try {
    return loadAccountCrypto();
  } catch (err) {
    // 软失败：worker 启动时不阻塞 server 上线；任何需要 crypto 的 job 失败时会自然报错
    console.warn("AccountJobsWorker: failed to load crypto; jobs requiring secrets will fail:", err);
    // 返回一个永远失败的 crypto 占位
    return {
      encrypt: () => {
        throw err instanceof Error ? err : new Error(String(err));
      },
      decrypt: () => {
        throw err instanceof Error ? err : new Error(String(err));
      },
      encryptOptional: () => {
        throw err instanceof Error ? err : new Error(String(err));
      },
      decryptOptional: (v) => {
        if (v === null || v === undefined) return null;
        throw err instanceof Error ? err : new Error(String(err));
      }
    };
  }
}

/** 简单 redact：把 token / refresh_token / 长 JWT / 手机号替成 `***`。 */
function redactErrorMessage(message: string): string {
  return message
    .replace(/eyJ[A-Za-z0-9._-]{40,}/g, "***JWT***")
    .replace(/rt_[A-Za-z0-9._-]{30,}/g, "***RT***")
    .replace(/\+\d{7,15}/g, "***PHONE***");
}
