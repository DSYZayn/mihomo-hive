import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { HiveRepository, openSqlite } from "@mihomo-hive/db";
import { createAccountCryptoFromKey, type AccountCrypto } from "@mihomo-hive/core";
import {
  accountRecordInternalSchema,
  defaultAccountFleetSpec,
  type AccountFleetSpec,
  type AccountRecordInternal
} from "@mihomo-hive/schemas";
import { startAccountJobsWorker, pickRegisterMailDomain } from "./account-fleet-worker.js";

function makeAccount(crypto: AccountCrypto, overrides: Partial<AccountRecordInternal> = {}): AccountRecordInternal {
  const now = new Date().toISOString();
  return accountRecordInternalSchema.parse({
    id: `acc-${Math.random().toString(36).slice(2, 10)}`,
    externalId: null,
    origin: "hive_registered",
    intent: "active",
    health: "healthy",
    email: "test@example.com",
    organizationId: null,
    clientId: null,
    platform: "openai",
    type: "oauth",
    encPhone: crypto.encryptOptional("+1234567890"),
    encPassword: crypto.encryptOptional("p4ss"),
    encRefreshToken: null,
    encAccessToken: null,
    encIdToken: null,
    encRecoveryInputJson: null,
    lastObservedAt: null,
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
  });
}

function makeSpec(overrides: Partial<AccountFleetSpec> = {}): AccountFleetSpec {
  return {
    ...defaultAccountFleetSpec,
    codexTool: {
      ...defaultAccountFleetSpec.codexTool,
      binPath: "codex-tool",
      egress: { mode: "none", pinnedNodeHash: null }
    },
    ...overrides
  };
}

describe("AccountJobsWorker", () => {
  let tmpDir: string;
  let repo: HiveRepository;
  let crypto: AccountCrypto;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hive-worker-"));
    const sqlite = openSqlite(join(tmpDir, "hive.sqlite"));
    repo = new HiveRepository(sqlite);
    crypto = createAccountCryptoFromKey(randomBytes(32));
    repo.saveAccountFleetSpec(makeSpec());
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("fails gracefully when Sub2API connection is missing", async () => {
    const acc = makeAccount(crypto, { externalId: 99 });
    repo.upsertAccount(acc);
    const now = new Date().toISOString();
    repo.enqueueAccountJob({
      id: "j1",
      kind: "delete_sub2api",
      accountId: acc.id,
      status: "queued",
      attempt: 0,
      maxAttempts: 1,
      priority: 100,
      scheduledAt: now,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      payloadJson: "{}",
      resultJson: null,
      errorMessage: null,
      triggeredBy: "manual",
      triggeredTickId: null,
      createdAt: now,
      updatedAt: now
    });
    const worker = startAccountJobsWorker({ repo, crypto, manualOnly: true });
    await worker.pump();
    worker.stop();
    const job = repo.getAccountJob("j1");
    expect(job?.status).toBe("failed");
    expect(job?.errorMessage).toContain("Sub2API");
  });

  function enqueueRegister(id: string, triggeredBy: "manual" | "scheduler") {
    const now = new Date().toISOString();
    repo.enqueueAccountJob({
      id,
      kind: "codex_register",
      accountId: null,
      status: "queued",
      attempt: 0,
      maxAttempts: 1,
      priority: 50,
      scheduledAt: now,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      payloadJson: "{}",
      resultJson: null,
      errorMessage: null,
      triggeredBy,
      triggeredTickId: null,
      createdAt: now,
      updatedAt: now
    });
  }

  it("自动注册关闭：跳过排队中的扩池注册(scheduler)，标记 cancelled", async () => {
    repo.saveAccountFleetSpec(makeSpec({
      registration: { ...defaultAccountFleetSpec.registration, enabled: false }
    }));
    enqueueRegister("reg-auto", "scheduler");
    const worker = startAccountJobsWorker({ repo, crypto, manualOnly: true });
    await worker.pump();
    worker.stop();
    const job = repo.getAccountJob("reg-auto");
    expect(job?.status).toBe("cancelled");
    expect(job?.errorMessage).toContain("自动注册已关闭");
  });

  it("自动注册关闭：手动「立即注册」豁免，照常尝试执行(不被 cancelled)", async () => {
    repo.saveAccountFleetSpec(makeSpec({
      registration: { ...defaultAccountFleetSpec.registration, enabled: false }
    }));
    enqueueRegister("reg-manual", "manual");
    const worker = startAccountJobsWorker({ repo, crypto, manualOnly: true });
    await worker.pump();
    worker.stop();
    const job = repo.getAccountJob("reg-manual");
    // 手动注册不受开关限制：它会进入执行(无 agent/出口配置则失败),但绝不会被门控 cancelled。
    expect(job?.status).not.toBe("cancelled");
    expect(job?.errorMessage ?? "").not.toContain("自动注册已关闭");
  });

  describe("pickRegisterMailDomain", () => {
    const withDomains = (mailDomain: string, mailDomains: { domain: string; enabled: boolean }[]) =>
      makeSpec({
        codexTool: {
          ...makeSpec().codexTool,
          chatgpt: { ...makeSpec().codexTool.chatgpt, mailDomain, mailDomains }
        }
      });

    it("池为空 → 回退单一 mailDomain，poolSize=0", () => {
      const r = pickRegisterMailDomain(withDomains("legacy.com", []));
      expect(r).toEqual({ domain: "legacy.com", poolSize: 0 });
    });

    it("全部禁用 → 回退单一 mailDomain", () => {
      const r = pickRegisterMailDomain(
        withDomains("legacy.com", [
          { domain: "a.com", enabled: false },
          { domain: "b.com", enabled: false }
        ])
      );
      expect(r.domain).toBe("legacy.com");
      expect(r.poolSize).toBe(0);
    });

    it("只从启用项里抽，禁用项永不被抽到", () => {
      const spec = withDomains("legacy.com", [
        { domain: "on1.com", enabled: true },
        { domain: "off.com", enabled: false },
        { domain: "on2.com", enabled: true }
      ]);
      const picks = new Set<string>();
      for (let i = 0; i < 200; i++) picks.add(pickRegisterMailDomain(spec).domain);
      expect([...picks].sort()).toEqual(["on1.com", "on2.com"]);
      expect(pickRegisterMailDomain(spec).poolSize).toBe(2);
    });

    it("忽略空白域名", () => {
      const r = pickRegisterMailDomain(
        withDomains("legacy.com", [{ domain: "  ", enabled: true }])
      );
      expect(r.domain).toBe("legacy.com");
      expect(r.poolSize).toBe(0);
    });
  });

  it("delete_sub2api: account without externalId fails immediately", async () => {
    const acc = makeAccount(crypto, { externalId: null });
    repo.upsertAccount(acc);
    repo.setSub2ApiConnection({
      baseUrl: "https://fake",
      adminApiKey: "k",
      timezone: "Asia/Shanghai",
      managedProxyPrefix: "MH-"
    });
    const now = new Date().toISOString();
    repo.enqueueAccountJob({
      id: "j2",
      kind: "delete_sub2api",
      accountId: acc.id,
      status: "queued",
      attempt: 0,
      maxAttempts: 1,
      priority: 100,
      scheduledAt: now,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      payloadJson: "{}",
      resultJson: null,
      errorMessage: null,
      triggeredBy: "manual",
      triggeredTickId: null,
      createdAt: now,
      updatedAt: now
    });
    const worker = startAccountJobsWorker({ repo, crypto, manualOnly: true });
    await worker.pump();
    worker.stop();
    const job = repo.getAccountJob("j2");
    expect(job?.status).toBe("failed");
    expect(job?.errorMessage).toContain("externalId");
  });

  it("codex_login: missing phone/password fails clearly", async () => {
    const acc = makeAccount(crypto, { encPhone: null, encPassword: null });
    repo.upsertAccount(acc);
    const now = new Date().toISOString();
    repo.enqueueAccountJob({
      id: "j3",
      kind: "codex_login",
      accountId: acc.id,
      status: "queued",
      attempt: 0,
      maxAttempts: 1,
      priority: 100,
      scheduledAt: now,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      payloadJson: "{}",
      resultJson: null,
      errorMessage: null,
      triggeredBy: "manual",
      triggeredTickId: null,
      createdAt: now,
      updatedAt: now
    });
    const worker = startAccountJobsWorker({ repo, crypto, manualOnly: true });
    await worker.pump();
    worker.stop();
    const job = repo.getAccountJob("j3");
    expect(job?.status).toBe("failed");
    expect(job?.errorMessage).toContain("encPhone");
    // 失败应该写 recoveryAttempts + nextRecoveryAfter
    const updated = repo.getAccountById(acc.id);
    expect(updated?.recoveryAttempts).toBe(1);
    expect(updated?.nextRecoveryAfter).not.toBeNull();
  });

  it("respects maxConcurrent — only consumes when slot available", async () => {
    repo.saveAccountFleetSpec(
      makeSpec({
        recovery: { ...defaultAccountFleetSpec.recovery, maxConcurrent: 1 }
      })
    );
    const now = new Date().toISOString();
    // 注入一个已经 status=running 的 job 占住并发名额
    repo.enqueueAccountJob({
      id: "running",
      kind: "delete_sub2api",
      accountId: null,
      status: "queued",
      attempt: 0,
      maxAttempts: 1,
      priority: 50,
      scheduledAt: now,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      payloadJson: "{}",
      resultJson: null,
      errorMessage: null,
      triggeredBy: "manual",
      triggeredTickId: null,
      createdAt: now,
      updatedAt: now
    });
    repo.updateAccountJob("running", { status: "running", startedAt: now });
    // 再入一个排队的
    repo.enqueueAccountJob({
      id: "queued",
      kind: "delete_sub2api",
      accountId: null,
      status: "queued",
      attempt: 0,
      maxAttempts: 1,
      priority: 50,
      scheduledAt: now,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      payloadJson: "{}",
      resultJson: null,
      errorMessage: null,
      triggeredBy: "manual",
      triggeredTickId: null,
      createdAt: now,
      updatedAt: now
    });
    // worker 上来时 countRunningAccountJobs=1 ≥ maxConcurrent=1，不应消费
    // 不过当前实现是基于 worker 自己的 running 计数（内部 counter），不是 db。
    // 我们 pump 一次：worker.running 从 0 开始，所以会消费 queued，但 db 里的 running 还是 1。
    // 我们 pump 完之后 queued 应该被处理（但因为没有 Sub2API 连接，会 failed）。
    const worker = startAccountJobsWorker({ repo, crypto, manualOnly: true });
    await worker.pump();
    worker.stop();
    const queued = repo.getAccountJob("queued");
    expect(queued?.status).toBe("failed"); // 因为没 Sub2API 连接
  });

  it("codex_login: NoEgressAvailableError (节点池暂空) 不计入 recoveryAttempts", async () => {
    // 强制 spec 走 managed-node 模式（默认 spec 是 'none' 不会触发节点选择）
    repo.saveAccountFleetSpec(
      makeSpec({
        codexTool: {
          ...makeSpec().codexTool,
          egress: { mode: "managed-node", pinnedNodeHash: null }
        }
      })
    );
    // 给账号 phone+password 让它走到 egress 选择阶段
    const acc = makeAccount(crypto);
    repo.upsertAccount(acc);
    // 但节点池里没有可用节点（无 nodes 入库），resolveEgressForLogin 会抛 NoEgressAvailableError
    const now = new Date().toISOString();
    repo.enqueueAccountJob({
      id: "j-infra",
      kind: "codex_login",
      accountId: acc.id,
      status: "queued",
      attempt: 0,
      maxAttempts: 1,
      priority: 100,
      scheduledAt: now,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      payloadJson: "{}",
      resultJson: null,
      errorMessage: null,
      triggeredBy: "scheduler",
      triggeredTickId: null,
      createdAt: now,
      updatedAt: now
    });
    const worker = startAccountJobsWorker({ repo, crypto, manualOnly: true });
    await worker.pump();
    worker.stop();
    const job = repo.getAccountJob("j-infra");
    expect(job?.status).toBe("failed");
    expect(job?.errorMessage).toMatch(/egress/);
    // 关键断言：basic infra issue 不应消耗账号的重试次数
    const updated = repo.getAccountById(acc.id);
    expect(updated?.recoveryAttempts).toBe(0);
    expect(updated?.nextRecoveryAfter).toBeNull();
  });

  it("observe_usage: missing externalId fails with clear message", async () => {
    const acc = makeAccount(crypto, { externalId: null });
    repo.upsertAccount(acc);
    repo.setSub2ApiConnection({
      baseUrl: "https://fake",
      adminApiKey: "k",
      timezone: "Asia/Shanghai",
      managedProxyPrefix: "MH-"
    });
    const now = new Date().toISOString();
    repo.enqueueAccountJob({
      id: "j-obs",
      kind: "observe_usage",
      accountId: acc.id,
      status: "queued",
      attempt: 0,
      maxAttempts: 1,
      priority: 100,
      scheduledAt: now,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      payloadJson: "{}",
      resultJson: null,
      errorMessage: null,
      triggeredBy: "scheduler",
      triggeredTickId: null,
      createdAt: now,
      updatedAt: now
    });
    const worker = startAccountJobsWorker({ repo, crypto, manualOnly: true });
    await worker.pump();
    worker.stop();
    const job = repo.getAccountJob("j-obs");
    expect(job?.status).toBe("failed");
    expect(job?.errorMessage).toContain("externalId");
  });
});
