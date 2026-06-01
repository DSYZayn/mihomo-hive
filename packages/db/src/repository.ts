import { readFile } from "node:fs/promises";
import {
  accountBudgetRecordSchema,
  accountFleetSpecSchema,
  accountFleetTickSchema,
  accountJobSchema,
  accountRecordInternalSchema,
  defaultAccountFleetSpec,
  defaultOrchestrationSpec,
  orchestrationSpecSchema,
  reconcileTickSchema,
  smsRegionHintMemorySchema,
  sub2ApiConnectionConfigSchema,
  sub2ApiProtectedProxyRuleSchema
} from "@mihomo-hive/schemas";
import type {
  AccountBudgetRecord,
  AccountChangeEntry,
  AccountFleetSpec,
  AccountFleetTick,
  AccountFleetTickSummary,
  AccountHealth,
  AccountIntent,
  AccountJob,
  AccountJobKind,
  AccountJobStatus,
  AccountOrigin,
  AccountRecordInternal,
  NodeIntentRole,
  NodeLifecycleStatus,
  OrchestrationSpec,
  ProxyNode,
  ReconcileTick,
  ReconcileTickSummary,
  SmsRegionHintMemory,
  Sub2ApiConnectionConfig,
  Sub2ApiProtectedProxyRule,
  Sub2ApiSafeConnectionConfig,
  SubscriptionSource
} from "@mihomo-hive/schemas";
import { appendAccountChanges, type AccountChangeSnapshot } from "./account-change-log.js";
import type { HiveSqlite } from "./client.js";

interface PasswordHash {
  algorithm: "scrypt";
  salt: string;
  hash: string;
  keyLength: number;
}

interface SubscriptionRow {
  id: string;
  name: string;
  kind: "url" | "file";
  value: string;
  enabled: 0 | 1;
  last_content: string | null;
  exclude_keywords: string;
  created_at: string;
  updated_at: string;
}

interface NodeRow {
  hash: string;
  source_id: string;
  name: string;
  original_name: string;
  type: string;
  region: string;
  raw_json: string;
  status: ProxyNode["status"];
  lifecycle_status: NodeLifecycleStatus;
  schedulable: 0 | 1;
  protected: 0 | 1;
  sub2api_proxy_id: number | null;
  quality_score: number | null;
  assigned_port: number | null;
  last_test_status: string | null;
  last_test_latency_ms: number | null;
  last_test_targets: string | null;
  intent_role: NodeIntentRole;
  backoff_until: string | null;
  backoff_attempts: number;
  health_score: number | null;
  last_health_check: string | null;
  codex_login_success: number;
  codex_login_failure: number;
  codex_register_success: number;
  codex_register_failure: number;
  codex_last_outcome: "success" | "failure" | null;
  codex_last_outcome_at: string | null;
  codex_reserved: 0 | 1;
  created_at: string;
  updated_at: string;
}

interface ReconcileTickRow {
  id: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  enabled: 0 | 1;
  skipped_reason: string;
  error_message: string | null;
  planned_total: number;
  applied_total: number;
  observed_json: string;
  node_intents_json: string;
  planned_changes_json: string;
  applied_changes_json: string;
  operation_id: string | null;
}

interface AuthSessionRow {
  id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
}

const authPasswordSettingKey = "auth.password";
const sub2ApiConnectionSettingKey = "sub2api.connection";
const sub2ApiProtectedRuleSettingKey = "sub2api.protectedRule";
const orchestrationSpecSettingKey = "orchestration.spec";
const accountFleetSpecSettingKey = "account_fleet.spec";
const accountFleetSmsRegionHintSettingKey = "account_fleet.smsRegionHint";

interface AccountRow {
  id: string;
  external_id: number | null;
  origin: AccountOrigin;
  intent: AccountIntent;
  health: AccountHealth;
  email: string;
  organization_id: string | null;
  client_id: string | null;
  platform: string;
  type: string;
  enc_phone: string | null;
  enc_password: string | null;
  enc_refresh_token: string | null;
  enc_access_token: string | null;
  enc_id_token: string | null;
  enc_recovery_input_json: string | null;
  last_observed_at: string | null;
  last_used_at: string | null;
  rate_limited_at: string | null;
  rate_limit_reset_at: string | null;
  quota_5h_percent: number | null;
  quota_7d_percent: number | null;
  errors_in_window: number;
  broken_since_tick: string | null;
  broken_consecutive_ticks: number;
  recovery_attempts: number;
  next_recovery_after: string | null;
  last_recovery_error: string | null;
  last_recovery_path: AccountRecordInternal["lastRecoveryPath"];
  last_recovery_failure_category: AccountRecordInternal["lastRecoveryFailureCategory"];
  ops_enabled: number;
  herosms_activation_id: string | null;
  batch_id: string | null;
  registered_at: string | null;
  sms_country: string | null;
  sms_cost_cents: number | null;
  egress_node_hash: string | null;
  first_seen_at: string | null;
  relogin_count: number;
  last_recovered_at: string | null;
  change_history: string | null;
  created_at: string;
  updated_at: string;
}

interface AccountJobRow {
  id: string;
  kind: AccountJobKind;
  account_id: string | null;
  status: AccountJobStatus;
  attempt: number;
  max_attempts: number;
  priority: number;
  scheduled_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  payload_json: string;
  result_json: string | null;
  error_message: string | null;
  log_tail: string | null;
  triggered_by: AccountJob["triggeredBy"];
  triggered_tick_id: string | null;
  created_at: string;
  updated_at: string;
}

interface AccountFleetTickRow {
  id: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  enabled: number;
  skipped_reason: AccountFleetTick["skippedReason"];
  error_message: string | null;
  planned_total: number;
  applied_total: number;
  observed_json: string;
  planned_actions_json: string;
  applied_actions_json: string;
  triggered_job_ids_json: string;
}

interface AccountBudgetRow {
  window_key: string;
  registrations_used: number;
  registrations_budget: number;
  sms_cost_cents: number;
  reset_at: string;
  updated_at: string;
}

export class HiveRepository {
  /** 每账号变更历史保留条数。由 spec 配置，saveAccountFleetSpec 时同步；默认 10。 */
  private accountChangeHistoryLimit = 10;

  constructor(
    private readonly sqlite: HiveSqlite,
    private readonly options: { subscriptionUserAgent?: string } = {}
  ) {
    try {
      this.accountChangeHistoryLimit = this.getAccountFleetSpec().changeHistoryLimit;
    } catch {
      // 设置表尚未就绪 / 旧数据解析失败 → 用默认值，saveAccountFleetSpec 时会刷新
    }
  }

  addSubscription(input: {
    id: string;
    name: string;
    kind: "url" | "file";
    value: string;
  }): SubscriptionSource {
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `
        INSERT INTO subscriptions (id, name, kind, value, enabled, exclude_keywords, created_at, updated_at)
        VALUES (@id, @name, @kind, @value, 1, '[]', @now, @now)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          kind = excluded.kind,
          value = excluded.value,
          enabled = 1,
          updated_at = excluded.updated_at
      `
      )
      .run({ ...input, now });
    return {
      id: input.id,
      name: input.name,
      kind: input.kind,
      value: input.value,
      enabled: true,
      excludeKeywords: [],
      createdAt: now,
      updatedAt: now
    };
  }

  listSubscriptions(): SubscriptionSource[] {
    const rows = this.sqlite
      .prepare("SELECT * FROM subscriptions ORDER BY created_at ASC")
      .all() as SubscriptionRow[];
    return rows.map(subscriptionFromRow);
  }

  async fetchSubscriptionContent(source: SubscriptionSource): Promise<string> {
    if (source.kind === "file") {
      return readFile(source.value, "utf8");
    }
    const response = await fetch(source.value, {
      headers: {
        "User-Agent": this.options.subscriptionUserAgent ?? "Clash.Meta",
        Accept: "text/yaml, application/yaml, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
      }
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch subscription ${source.name}: HTTP ${response.status}`);
    }
    return response.text();
  }

  updateSubscriptionContent(id: string, content: string): void {
    this.sqlite
      .prepare("UPDATE subscriptions SET last_content = ?, updated_at = ? WHERE id = ?")
      .run(content, new Date().toISOString(), id);
  }

  updateSubscriptionFilters(id: string, excludeKeywords: string[]): SubscriptionSource {
    const keywords = normalizeKeywords(excludeKeywords);
    this.sqlite
      .prepare("UPDATE subscriptions SET exclude_keywords = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(keywords), new Date().toISOString(), id);
    const row = this.sqlite.prepare("SELECT * FROM subscriptions WHERE id = ?").get(id) as SubscriptionRow | undefined;
    if (!row) {
      throw new Error(`Subscription not found: ${id}`);
    }
    return subscriptionFromRow(row);
  }

  deleteSubscription(id: string): void {
    const transaction = this.sqlite.transaction(() => {
      this.sqlite.prepare("DELETE FROM nodes WHERE source_id = ?").run(id);
      this.sqlite.prepare("DELETE FROM subscriptions WHERE id = ?").run(id);
    });
    transaction();
  }

  upsertNodes(nodes: ProxyNode[]): void {
    const statement = this.sqlite.prepare(`
      INSERT INTO nodes (
        hash, source_id, name, original_name, type, region, raw_json, status,
        lifecycle_status, schedulable, protected, sub2api_proxy_id, quality_score,
        assigned_port, last_test_status, last_test_latency_ms, last_test_targets,
        intent_role, backoff_until, backoff_attempts, health_score, last_health_check,
        created_at, updated_at
      )
      VALUES (
        @hash, @sourceId, @name, @originalName, @type, @region, @rawJson, @status,
        @lifecycleStatus, @schedulable, @protected, @sub2apiProxyId, @qualityScore,
        @assignedPort, @lastTestStatus, @lastTestLatencyMs, @lastTestTargets,
        @intentRole, @backoffUntil, @backoffAttempts, @healthScore, @lastHealthCheck,
        @createdAt, @updatedAt
      )
      ON CONFLICT(hash) DO UPDATE SET
        source_id = excluded.source_id,
        name = excluded.name,
        original_name = excluded.original_name,
        type = excluded.type,
        region = excluded.region,
        raw_json = excluded.raw_json,
        lifecycle_status = CASE
          WHEN nodes.lifecycle_status IN ('deleted', 'retired') THEN nodes.lifecycle_status
          ELSE excluded.lifecycle_status
        END,
        updated_at = excluded.updated_at
    `);

    const transaction = this.sqlite.transaction((items: ProxyNode[]) => {
      for (const node of items) {
        statement.run({
          hash: node.hash,
          sourceId: node.sourceId,
          name: node.name,
          originalName: node.originalName,
          type: node.type,
          region: node.region,
          rawJson: JSON.stringify(node.raw),
          status: node.status,
          lifecycleStatus: node.lifecycleStatus ?? lifecycleFromStatus(node.status),
          schedulable: node.schedulable ? 1 : 0,
          protected: node.protected ? 1 : 0,
          sub2apiProxyId: node.sub2apiProxyId ?? null,
          qualityScore: node.qualityScore ?? null,
          assignedPort: node.assignedPort ?? null,
          lastTestStatus: node.lastTestStatus ?? null,
          lastTestLatencyMs: node.lastTestLatencyMs ?? null,
          lastTestTargets: node.lastTestTargets ?? null,
          intentRole: node.intentRole ?? intentFromLifecycle(node.lifecycleStatus ?? lifecycleFromStatus(node.status)),
          backoffUntil: node.backoffUntil ?? null,
          backoffAttempts: node.backoffAttempts ?? 0,
          healthScore: node.healthScore ?? null,
          lastHealthCheck: node.lastHealthCheck ?? null,
          createdAt: node.createdAt,
          updatedAt: node.updatedAt
        });
      }
    });

    transaction(nodes);
  }

  listNodes(): ProxyNode[] {
    const rows = this.sqlite.prepare("SELECT * FROM nodes ORDER BY assigned_port, name").all() as NodeRow[];
    return rows.map(nodeFromRow);
  }

  /**
   * 记录一次 codex_login 经某节点出口的实战结果（P5-AS）。原子自增对应计数，
   * 并写最近结果/时间。节点不存在（hash 已删）时静默 no-op。
   */
  recordNodeCodexOutcome(
    nodeHash: string,
    outcome: "success" | "failure",
    kind: "login" | "register" = "login"
  ): void {
    const now = new Date().toISOString();
    // 登录与注册各自计数:能登录 ≠ 能注册,分开统计才不互相误导选节点。
    const prefix = kind === "register" ? "codex_register" : "codex_login";
    const col = outcome === "success" ? `${prefix}_success` : `${prefix}_failure`;
    this.sqlite
      .prepare(
        `UPDATE nodes SET ${col} = ${col} + 1, codex_last_outcome = ?, codex_last_outcome_at = ?, updated_at = ? WHERE hash = ?`
      )
      .run(outcome, now, now, nodeHash);
  }

  /** 标记/取消保留节点（P5-AS）。返回是否命中某行。 */
  setNodeCodexReserved(nodeHash: string, reserved: boolean): boolean {
    const now = new Date().toISOString();
    return (
      this.sqlite
        .prepare("UPDATE nodes SET codex_reserved = ?, updated_at = ? WHERE hash = ?")
        .run(reserved ? 1 : 0, now, nodeHash).changes > 0
    );
  }

  saveNodes(nodes: ProxyNode[]): void {
    const statement = this.sqlite.prepare(`
      UPDATE nodes SET
        name = @name,
        status = @status,
        lifecycle_status = @lifecycleStatus,
        schedulable = @schedulable,
        protected = @protected,
        sub2api_proxy_id = @sub2apiProxyId,
        quality_score = @qualityScore,
        assigned_port = @assignedPort,
        last_test_status = @lastTestStatus,
        last_test_latency_ms = @lastTestLatencyMs,
        last_test_targets = @lastTestTargets,
        intent_role = @intentRole,
        backoff_until = @backoffUntil,
        backoff_attempts = @backoffAttempts,
        health_score = @healthScore,
        last_health_check = @lastHealthCheck,
        updated_at = @updatedAt
      WHERE hash = @hash
    `);

    const transaction = this.sqlite.transaction((items: ProxyNode[]) => {
      for (const node of items) {
        statement.run({
          hash: node.hash,
          name: node.name,
          status: node.status,
          lifecycleStatus: node.lifecycleStatus ?? lifecycleFromStatus(node.status),
          schedulable: node.schedulable ? 1 : 0,
          protected: node.protected ? 1 : 0,
          sub2apiProxyId: node.sub2apiProxyId ?? null,
          qualityScore: node.qualityScore ?? null,
          assignedPort: node.assignedPort ?? null,
          lastTestStatus: node.lastTestStatus ?? null,
          lastTestLatencyMs: node.lastTestLatencyMs ?? null,
          lastTestTargets: node.lastTestTargets ?? null,
          intentRole: node.intentRole ?? intentFromLifecycle(node.lifecycleStatus ?? lifecycleFromStatus(node.status)),
          backoffUntil: node.backoffUntil ?? null,
          backoffAttempts: node.backoffAttempts ?? 0,
          healthScore: node.healthScore ?? null,
          lastHealthCheck: node.lastHealthCheck ?? null,
          updatedAt: new Date().toISOString()
        });
      }
    });

    transaction(nodes);
  }

  setAllUntestedActive(): void {
    this.sqlite
      .prepare("UPDATE nodes SET status = 'active', lifecycle_status = 'schedulable', schedulable = 1 WHERE status = 'untested'")
      .run();
  }

  deleteNodes(hashes: string[]): number {
    if (hashes.length === 0) {
      return 0;
    }
    const statement = this.sqlite.prepare("DELETE FROM nodes WHERE hash = ?");
    const transaction = this.sqlite.transaction((items: string[]) => {
      let deleted = 0;
      for (const hash of items) {
        deleted += statement.run(hash).changes;
      }
      return deleted;
    });
    return transaction(hashes) as number;
  }

  /**
   * 重置节点的编排意图状态：清掉 intent_role / backoff / health_score / last_health_check，
   * 让下次 reconcile 重新评估。
   *
   * 同时清掉 `sub2api_proxy_id`：被驱逐过的节点端口已被 assignStablePorts 收回，
   * 但 sub2api_proxy_id 留着会指向 Sub2API 端的"孤儿代理"（host:port 还指向一个
   * 已经不存在的本地 listener）。清掉映射让节点跟孤儿脱钩；用户后续走"分配端口
   * + 启用调度"会触发 importProxyData 建新代理 + 重建映射。Sub2API 端的孤儿
   * 代理由 sub2api.maintenance.cleanupEmpty 清。
   *
   * 主要用途：把因为健康信号误归因被 quarantined / evicted 的节点恢复回评估池。
   * **不**改 lifecycle_status —— 调用方需要单独把 retired 节点改回 schedulable。
   */
  resetNodeIntent(hashes: string[]): ProxyNode[] {
    if (hashes.length === 0) {
      return [];
    }
    const statement = this.sqlite.prepare(`
      UPDATE nodes SET
        intent_role = 'standby',
        backoff_until = NULL,
        backoff_attempts = 0,
        health_score = NULL,
        last_health_check = NULL,
        sub2api_proxy_id = NULL,
        updated_at = @updatedAt
      WHERE hash = @hash
    `);
    const now = new Date().toISOString();
    const transaction = this.sqlite.transaction((items: string[]) => {
      for (const hash of items) {
        statement.run({ hash, updatedAt: now });
      }
    });
    transaction(hashes);
    const wanted = new Set(hashes);
    return this.listNodes().filter((node) => wanted.has(node.hash));
  }

  markNodesLifecycle(hashes: string[], lifecycleStatus: NodeLifecycleStatus): ProxyNode[] {
    if (hashes.length === 0) {
      return [];
    }
    const status = statusFromLifecycle(lifecycleStatus);
    const schedulable = lifecycleStatus === "schedulable" ? 1 : 0;
    const statement = this.sqlite.prepare(`
      UPDATE nodes SET
        lifecycle_status = @lifecycleStatus,
        status = @status,
        schedulable = @schedulable,
        assigned_port = CASE WHEN @schedulable = 1 THEN assigned_port ELSE assigned_port END,
        updated_at = @updatedAt
      WHERE hash = @hash
    `);
    const now = new Date().toISOString();
    const transaction = this.sqlite.transaction((items: string[]) => {
      for (const hash of items) {
        statement.run({ hash, lifecycleStatus, status, schedulable, updatedAt: now });
      }
    });
    transaction(hashes);
    const wanted = new Set(hashes);
    return this.listNodes().filter((node) => wanted.has(node.hash));
  }

  updateSub2ApiProxyMappings(mappings: Array<{ hash: string; proxyId: number }>): void {
    const statement = this.sqlite.prepare("UPDATE nodes SET sub2api_proxy_id = ?, updated_at = ? WHERE hash = ?");
    const now = new Date().toISOString();
    const transaction = this.sqlite.transaction((items: Array<{ hash: string; proxyId: number }>) => {
      for (const item of items) {
        statement.run(item.proxyId, now, item.hash);
      }
    });
    transaction(mappings);
  }

  getPasswordHash(): PasswordHash | undefined {
    const row = this.sqlite
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .get(authPasswordSettingKey) as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as PasswordHash) : undefined;
  }

  hasPassword(): boolean {
    return Boolean(this.getPasswordHash());
  }

  setPasswordHash(hash: PasswordHash): void {
    this.sqlite
      .prepare(
        `
        INSERT INTO settings (key, value_json)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
      `
      )
      .run(authPasswordSettingKey, JSON.stringify(hash));
  }

  resetPassword(hash: PasswordHash): void {
    const transaction = this.sqlite.transaction(() => {
      this.setPasswordHash(hash);
      this.sqlite.prepare("DELETE FROM auth_sessions").run();
    });
    transaction();
  }

  createSession(input: { id: string; tokenHash: string; expiresAt: string }): void {
    this.deleteExpiredSessions();
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `
        INSERT INTO auth_sessions (id, token_hash, created_at, expires_at)
        VALUES (@id, @tokenHash, @now, @expiresAt)
      `
      )
      .run({ ...input, now });
  }

  findSessionByTokenHash(tokenHash: string): AuthSessionRow | undefined {
    this.deleteExpiredSessions();
    return this.sqlite
      .prepare("SELECT * FROM auth_sessions WHERE token_hash = ? AND expires_at > ?")
      .get(tokenHash, new Date().toISOString()) as AuthSessionRow | undefined;
  }

  deleteSessionByTokenHash(tokenHash: string): void {
    this.sqlite.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash);
  }

  deleteExpiredSessions(): void {
    this.sqlite.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(new Date().toISOString());
  }

  getSub2ApiConnection(): Sub2ApiConnectionConfig | undefined {
    const row = this.sqlite
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .get(sub2ApiConnectionSettingKey) as { value_json: string } | undefined;
    return row ? sub2ApiConnectionConfigSchema.parse(JSON.parse(row.value_json)) : undefined;
  }

  getSafeSub2ApiConnection(): Sub2ApiSafeConnectionConfig {
    const connection = this.getSub2ApiConnection();
    return {
      configured: Boolean(connection),
      ...(connection
        ? {
            baseUrl: connection.baseUrl,
            timezone: connection.timezone,
            managedProxyPrefix: connection.managedProxyPrefix
          }
        : {}),
      apiKeyConfigured: Boolean(connection?.adminApiKey)
    };
  }

  setSub2ApiConnection(config: Sub2ApiConnectionConfig): void {
    const parsed = sub2ApiConnectionConfigSchema.parse(config);
    this.sqlite
      .prepare(
        `
        INSERT INTO settings (key, value_json)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
      `
      )
      .run(sub2ApiConnectionSettingKey, JSON.stringify(parsed));
  }

  getSub2ApiProtectedRule(): Sub2ApiProtectedProxyRule {
    const row = this.sqlite
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .get(sub2ApiProtectedRuleSettingKey) as { value_json: string } | undefined;
    return sub2ApiProtectedProxyRuleSchema.parse(row ? JSON.parse(row.value_json) : {});
  }

  setSub2ApiProtectedRule(rule: Sub2ApiProtectedProxyRule): void {
    const parsed = sub2ApiProtectedProxyRuleSchema.parse(rule);
    this.sqlite
      .prepare(
        `
        INSERT INTO settings (key, value_json)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
      `
      )
      .run(sub2ApiProtectedRuleSettingKey, JSON.stringify(parsed));
  }

  // —— OrchestrationSpec (ADR 0003) ——

  getOrchestrationSpec(): OrchestrationSpec {
    const row = this.sqlite
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .get(orchestrationSpecSettingKey) as { value_json: string } | undefined;
    if (!row) {
      return defaultOrchestrationSpec;
    }
    try {
      return orchestrationSpecSchema.parse(JSON.parse(row.value_json));
    } catch {
      // schema 升级后旧数据无法 parse，退回默认值，避免崩
      return defaultOrchestrationSpec;
    }
  }

  saveOrchestrationSpec(spec: OrchestrationSpec): OrchestrationSpec {
    const parsed = orchestrationSpecSchema.parse(spec);
    this.sqlite
      .prepare(
        `
        INSERT INTO settings (key, value_json)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
      `
      )
      .run(orchestrationSpecSettingKey, JSON.stringify(parsed));
    return parsed;
  }

  // —— Reconcile tick 持久化 ——

  appendReconcileTick(tick: ReconcileTick): void {
    this.sqlite
      .prepare(
        `
        INSERT INTO reconcile_ticks (
          id, started_at, finished_at, duration_ms, enabled,
          skipped_reason, error_message, planned_total, applied_total,
          observed_json, node_intents_json, planned_changes_json,
          applied_changes_json, operation_id
        ) VALUES (
          @id, @startedAt, @finishedAt, @durationMs, @enabled,
          @skippedReason, @errorMessage, @plannedTotal, @appliedTotal,
          @observedJson, @nodeIntentsJson, @plannedChangesJson,
          @appliedChangesJson, @operationId
        )
      `
      )
      .run({
        id: tick.id,
        startedAt: tick.startedAt,
        finishedAt: tick.finishedAt,
        durationMs: tick.durationMs,
        enabled: tick.enabled ? 1 : 0,
        skippedReason: tick.skippedReason,
        errorMessage: tick.errorMessage ?? null,
        plannedTotal: tick.plannedTotal,
        appliedTotal: tick.appliedTotal,
        observedJson: JSON.stringify(tick.observedSummary),
        nodeIntentsJson: JSON.stringify(tick.nodeIntents),
        plannedChangesJson: JSON.stringify(tick.plannedChanges),
        appliedChangesJson: JSON.stringify(tick.appliedChanges),
        operationId: tick.operationId ?? null
      });
  }

  listRecentReconcileTicks(limit = 20): ReconcileTick[] {
    const rows = this.sqlite
      .prepare("SELECT * FROM reconcile_ticks ORDER BY started_at DESC LIMIT ?")
      .all(limit) as ReconcileTickRow[];
    return rows.map(reconcileTickFromRow);
  }

  /**
   * 只读 tick 的摘要字段，跳过 4 个 JSON 大列 + 不走 zod schema parse。
   * 用于历史列表展示；单条详情走 getReconcileTick(id)。
   *
   * 性能：500 条记录从原来的 ~500ms（JSON.parse × 2000 + zod × 500）降到 ~5ms。
   */
  listRecentReconcileTickSummaries(limit = 200): ReconcileTickSummary[] {
    const rows = this.sqlite
      .prepare(
        "SELECT id, started_at, finished_at, duration_ms, enabled, planned_total, applied_total, skipped_reason, error_message FROM reconcile_ticks ORDER BY started_at DESC LIMIT ?"
      )
      .all(limit) as Array<{
      id: string;
      started_at: string;
      finished_at: string;
      duration_ms: number;
      enabled: number;
      planned_total: number;
      applied_total: number;
      skipped_reason: ReconcileTick["skippedReason"];
      error_message: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      enabled: Boolean(row.enabled),
      plannedTotal: row.planned_total,
      appliedTotal: row.applied_total,
      skippedReason: row.skipped_reason,
      ...(row.error_message ? { errorMessage: row.error_message } : {})
    }));
  }

  getReconcileTick(id: string): ReconcileTick | undefined {
    const row = this.sqlite
      .prepare("SELECT * FROM reconcile_ticks WHERE id = ? LIMIT 1")
      .get(id) as ReconcileTickRow | undefined;
    return row ? reconcileTickFromRow(row) : undefined;
  }

  /** SQL 聚合统计 24h 内 applied 类型变更总数（rebalance_overload / drift_correction / rebind_dead）。
   *  避免在 JS 层 reduce 500 条 ticks。 */
  countDriftAppliedChanges(sinceIso: string): number {
    // appliedChanges JSON 字段无法直接用 SQL 聚合 kind 字段，只能拉 applied_changes_json 列
    // 但 better-sqlite3 的 JSON1 扩展可用 json_each。如果不可用就退化为 JS reduce。
    try {
      const result = this.sqlite
        .prepare(
          `SELECT COUNT(*) as count FROM reconcile_ticks, json_each(reconcile_ticks.applied_changes_json) AS change
           WHERE reconcile_ticks.started_at >= ?
             AND json_extract(change.value, '$.kind') IN ('rebalance_overload', 'drift_correction', 'rebind_dead')`
        )
        .get(sinceIso) as { count: number } | undefined;
      return result?.count ?? 0;
    } catch {
      // JSON1 不可用，退化：只拉这一列做 JS reduce
      const rows = this.sqlite
        .prepare(
          "SELECT applied_changes_json FROM reconcile_ticks WHERE started_at >= ?"
        )
        .all(sinceIso) as Array<{ applied_changes_json: string }>;
      let total = 0;
      for (const row of rows) {
        try {
          const changes = JSON.parse(row.applied_changes_json) as Array<{ kind: string }>;
          total += changes.filter(
            (c) => c.kind === "rebalance_overload" || c.kind === "drift_correction" || c.kind === "rebind_dead"
          ).length;
        } catch {
          // skip
        }
      }
      return total;
    }
  }

  pruneReconcileTicks(keepDays = 7): number {
    const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();
    return this.sqlite.prepare("DELETE FROM reconcile_ticks WHERE started_at < ?").run(cutoff).changes;
  }

  // ─── Account Fleet (notes/account-fleet-design.md) ─────────────

  getAccountFleetSpec(): AccountFleetSpec {
    const row = this.sqlite
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .get(accountFleetSpecSettingKey) as { value_json: string } | undefined;
    if (!row) {
      return defaultAccountFleetSpec;
    }
    try {
      return accountFleetSpecSchema.parse(JSON.parse(row.value_json));
    } catch {
      return defaultAccountFleetSpec;
    }
  }

  saveAccountFleetSpec(spec: AccountFleetSpec): AccountFleetSpec {
    const parsed = accountFleetSpecSchema.parse(spec);
    this.sqlite
      .prepare(
        `
        INSERT INTO settings (key, value_json)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
      `
      )
      .run(accountFleetSpecSettingKey, JSON.stringify(parsed));
    this.accountChangeHistoryLimit = parsed.changeHistoryLimit;
    return parsed;
  }

  /**
   * codex-tool 短信地区经验透明回灌（P5-AI / external-integration.md §"成本上限和选区策略"）。
   *
   * Hive 完全黑盒：把 sms_region_result 整个 blob 当作 unknown 存到 settings，
   * 下次注册前作为 phone_sms.region_hint 原样回传。lastUpdatedAt 由 Hive 在写入时
   * 打戳，让 UI 能显示"经验新鲜度"。返回 null 表示从未保存过经验。
   */
  getSmsRegionHint(): SmsRegionHintMemory | null {
    const row = this.sqlite
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .get(accountFleetSmsRegionHintSettingKey) as { value_json: string } | undefined;
    if (!row) return null;
    try {
      return smsRegionHintMemorySchema.parse(JSON.parse(row.value_json));
    } catch {
      return null;
    }
  }

  saveSmsRegionHint(hint: unknown): SmsRegionHintMemory {
    const memory: SmsRegionHintMemory = { hint: hint ?? null, lastUpdatedAt: new Date().toISOString() };
    this.sqlite
      .prepare(
        `
        INSERT INTO settings (key, value_json)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
      `
      )
      .run(accountFleetSmsRegionHintSettingKey, JSON.stringify(memory));
    return memory;
  }

  upsertAccount(record: AccountRecordInternal): AccountRecordInternal {
    // 变更历史：拿旧行 diff（health/intent/额度），自动追加到环形缓冲
    const existing = this.getAccountById(record.id);
    const changeHistory = appendAccountChanges(
      existing?.changeHistory ?? [],
      existing ? changeSnapshot(existing) : null,
      changeSnapshot(record),
      record.updatedAt,
      this.accountChangeHistoryLimit
    );
    const parsed = accountRecordInternalSchema.parse({ ...record, changeHistory });
    this.sqlite
      .prepare(
        `
        INSERT INTO accounts (
          id, external_id, origin, intent, health,
          email, organization_id, client_id, platform, type,
          enc_phone, enc_password, enc_refresh_token, enc_access_token, enc_id_token,
          enc_recovery_input_json,
          last_observed_at, last_used_at, rate_limited_at, rate_limit_reset_at,
          quota_5h_percent, quota_7d_percent, errors_in_window,
          broken_since_tick, broken_consecutive_ticks,
          recovery_attempts, next_recovery_after, last_recovery_error, last_recovery_path,
          last_recovery_failure_category, ops_enabled, herosms_activation_id,
          batch_id, registered_at, sms_country, sms_cost_cents, egress_node_hash,
          first_seen_at, relogin_count, last_recovered_at, change_history,
          created_at, updated_at
        ) VALUES (
          @id, @externalId, @origin, @intent, @health,
          @email, @organizationId, @clientId, @platform, @type,
          @encPhone, @encPassword, @encRefreshToken, @encAccessToken, @encIdToken,
          @encRecoveryInputJson,
          @lastObservedAt, @lastUsedAt, @rateLimitedAt, @rateLimitResetAt,
          @quota5hPercent, @quota7dPercent, @errorsInWindow,
          @brokenSinceTick, @brokenConsecutiveTicks,
          @recoveryAttempts, @nextRecoveryAfter, @lastRecoveryError, @lastRecoveryPath,
          @lastRecoveryFailureCategory, @opsEnabled, @herosmsActivationId,
          @batchId, @registeredAt, @smsCountry, @smsCostCents, @egressNodeHash,
          @firstSeenAt, @reloginCount, @lastRecoveredAt, @changeHistory,
          @createdAt, @updatedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          external_id = excluded.external_id,
          origin = excluded.origin,
          intent = excluded.intent,
          health = excluded.health,
          email = excluded.email,
          organization_id = excluded.organization_id,
          client_id = excluded.client_id,
          platform = excluded.platform,
          type = excluded.type,
          enc_phone = excluded.enc_phone,
          enc_password = excluded.enc_password,
          enc_refresh_token = excluded.enc_refresh_token,
          enc_access_token = excluded.enc_access_token,
          enc_id_token = excluded.enc_id_token,
          enc_recovery_input_json = excluded.enc_recovery_input_json,
          last_observed_at = excluded.last_observed_at,
          last_used_at = excluded.last_used_at,
          rate_limited_at = excluded.rate_limited_at,
          rate_limit_reset_at = excluded.rate_limit_reset_at,
          quota_5h_percent = excluded.quota_5h_percent,
          quota_7d_percent = excluded.quota_7d_percent,
          errors_in_window = excluded.errors_in_window,
          broken_since_tick = excluded.broken_since_tick,
          broken_consecutive_ticks = excluded.broken_consecutive_ticks,
          recovery_attempts = excluded.recovery_attempts,
          next_recovery_after = excluded.next_recovery_after,
          last_recovery_error = excluded.last_recovery_error,
          last_recovery_path = excluded.last_recovery_path,
          last_recovery_failure_category = excluded.last_recovery_failure_category,
          ops_enabled = excluded.ops_enabled,
          herosms_activation_id = excluded.herosms_activation_id,
          batch_id = excluded.batch_id,
          registered_at = excluded.registered_at,
          sms_country = excluded.sms_country,
          sms_cost_cents = excluded.sms_cost_cents,
          egress_node_hash = excluded.egress_node_hash,
          first_seen_at = excluded.first_seen_at,
          relogin_count = excluded.relogin_count,
          last_recovered_at = excluded.last_recovered_at,
          change_history = excluded.change_history,
          updated_at = excluded.updated_at
      `
      )
      .run(toAccountRow(parsed));
    return parsed;
  }

  listAccounts(): AccountRecordInternal[] {
    const rows = this.sqlite.prepare("SELECT * FROM accounts ORDER BY created_at ASC").all() as AccountRow[];
    return rows.map(accountFromRow);
  }

  getAccountById(id: string): AccountRecordInternal | undefined {
    const row = this.sqlite.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
    return row ? accountFromRow(row) : undefined;
  }

  getAccountByExternalId(externalId: number): AccountRecordInternal | undefined {
    const row = this.sqlite
      .prepare("SELECT * FROM accounts WHERE external_id = ?")
      .get(externalId) as AccountRow | undefined;
    return row ? accountFromRow(row) : undefined;
  }

  findAccountsByEmail(email: string): AccountRecordInternal[] {
    const rows = this.sqlite.prepare("SELECT * FROM accounts WHERE email = ?").all(email) as AccountRow[];
    return rows.map(accountFromRow);
  }

  deleteAccount(id: string): boolean {
    return this.sqlite.prepare("DELETE FROM accounts WHERE id = ?").run(id).changes > 0;
  }

  /** 单字段更新，避免每次都构造完整 record。所有可观察字段都通过这个走。 */
  patchAccount(
    id: string,
    patch: Partial<{
      externalId: number | null;
      origin: AccountOrigin;
      intent: AccountIntent;
      health: AccountHealth;
      lastObservedAt: string | null;
      lastUsedAt: string | null;
      rateLimitedAt: string | null;
      rateLimitResetAt: string | null;
      quota5hPercent: number | null;
      quota7dPercent: number | null;
      errorsInWindow: number;
      brokenSinceTick: string | null;
      brokenConsecutiveTicks: number;
      recoveryAttempts: number;
      nextRecoveryAfter: string | null;
      lastRecoveryError: string | null;
      lastRecoveryPath: AccountRecordInternal["lastRecoveryPath"];
      encPhone: string | null;
      encPassword: string | null;
      encRefreshToken: string | null;
      encAccessToken: string | null;
      encIdToken: string | null;
      encRecoveryInputJson: string | null;
      organizationId: string | null;
      clientId: string | null;
      batchId: string | null;
      registeredAt: string | null;
      egressNodeHash: string | null;
      // P5-AI: codex-tool 注册阶段返回的元信息
      smsCountry: string | null;
      smsCostCents: number | null;
      lastRecoveryFailureCategory: AccountRecordInternal["lastRecoveryFailureCategory"];
      opsEnabled: boolean;
      herosmsActivationId: string | null;
      // P5-AQ: 质量指标
      firstSeenAt: string | null;
      reloginCount: number;
      lastRecoveredAt: string | null;
      email: string;
    }>
  ): AccountRecordInternal | undefined {
    const fieldMap: Record<keyof typeof patch, string> = {
      externalId: "external_id",
      origin: "origin",
      intent: "intent",
      health: "health",
      email: "email",
      lastObservedAt: "last_observed_at",
      lastUsedAt: "last_used_at",
      rateLimitedAt: "rate_limited_at",
      rateLimitResetAt: "rate_limit_reset_at",
      quota5hPercent: "quota_5h_percent",
      quota7dPercent: "quota_7d_percent",
      errorsInWindow: "errors_in_window",
      brokenSinceTick: "broken_since_tick",
      brokenConsecutiveTicks: "broken_consecutive_ticks",
      recoveryAttempts: "recovery_attempts",
      nextRecoveryAfter: "next_recovery_after",
      lastRecoveryError: "last_recovery_error",
      lastRecoveryPath: "last_recovery_path",
      lastRecoveryFailureCategory: "last_recovery_failure_category",
      opsEnabled: "ops_enabled",
      herosmsActivationId: "herosms_activation_id",
      encPhone: "enc_phone",
      encPassword: "enc_password",
      encRefreshToken: "enc_refresh_token",
      encAccessToken: "enc_access_token",
      encIdToken: "enc_id_token",
      encRecoveryInputJson: "enc_recovery_input_json",
      organizationId: "organization_id",
      clientId: "client_id",
      batchId: "batch_id",
      registeredAt: "registered_at",
      smsCountry: "sms_country",
      smsCostCents: "sms_cost_cents",
      egressNodeHash: "egress_node_hash",
      firstSeenAt: "first_seen_at",
      reloginCount: "relogin_count",
      lastRecoveredAt: "last_recovered_at"
    };
    const sets: string[] = [];
    const values: Record<string, unknown> = {};
    for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
      const column = fieldMap[key];
      if (!column) continue;
      sets.push(`${column} = @${key}`);
      const v = patch[key];
      values[key] = typeof v === "boolean" ? (v ? 1 : 0) : (v ?? null);
    }
    if (sets.length === 0) {
      return this.getAccountById(id);
    }
    const now = new Date().toISOString();
    // 变更历史：patch 触及 health/intent/额度时，拿旧行 diff 后追加（同 updated_at 时间戳）
    if ("health" in patch || "intent" in patch || "quota5hPercent" in patch || "quota7dPercent" in patch) {
      const before = this.getAccountById(id);
      if (before) {
        const next: AccountChangeSnapshot = {
          health: "health" in patch ? patch.health! : before.health,
          intent: "intent" in patch ? patch.intent! : before.intent,
          quota5hPercent: "quota5hPercent" in patch ? (patch.quota5hPercent ?? null) : before.quota5hPercent,
          quota7dPercent: "quota7dPercent" in patch ? (patch.quota7dPercent ?? null) : before.quota7dPercent
        };
        const history = appendAccountChanges(
          before.changeHistory ?? [],
          changeSnapshot(before),
          next,
          now,
          this.accountChangeHistoryLimit
        );
        sets.push(`change_history = @changeHistory`);
        values.changeHistory = history.length > 0 ? JSON.stringify(history) : null;
      }
    }
    sets.push(`updated_at = @updatedAt`);
    values.updatedAt = now;
    values.id = id;
    this.sqlite
      .prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = @id`)
      .run(values);
    return this.getAccountById(id);
  }

  /** 单账号设置运维开关。关闭时同时清掉该账号已排队的任务(不只是停新分配)。 */
  setAccountOpsEnabled(id: string, enabled: boolean): AccountRecordInternal | undefined {
    const updated = this.patchAccount(id, { opsEnabled: enabled });
    if (updated && !enabled) this.cancelQueuedJobsForAccount(id, "运维已暂停");
    return updated;
  }

  /**
   * 批量设置运维开关。onlyNonActive=true 只动非 active 账号,否则动全部。
   * 关闭时**同时删除这些账号已排队的 job**(清掉已分配任务,彻底隔离)。返回 {accounts, cancelledJobs}。
   */
  setAllOpsEnabled(enabled: boolean, opts?: { onlyNonActive?: boolean }): { accounts: number; cancelledJobs: number } {
    const now = new Date().toISOString();
    const where = opts?.onlyNonActive ? "WHERE intent != 'active'" : "";
    const accounts = this.sqlite
      .prepare(`UPDATE accounts SET ops_enabled = ?, updated_at = ? ${where}`)
      .run(enabled ? 1 : 0, now).changes;
    let cancelledJobs = 0;
    if (!enabled) {
      // 删除所有"运维已关闭"账号的 queued job（已分配但还没跑的任务一并清掉）。
      cancelledJobs = this.sqlite
        .prepare(
          "DELETE FROM account_jobs WHERE status = 'queued' AND account_id IN " +
            "(SELECT id FROM accounts WHERE ops_enabled = 0)"
        )
        .run().changes;
    }
    return { accounts, cancelledJobs };
  }

  // —— Account Jobs ——

  enqueueAccountJob(job: AccountJob): AccountJob {
    const parsed = accountJobSchema.parse(job);
    this.sqlite
      .prepare(
        `
        INSERT INTO account_jobs (
          id, kind, account_id, status, attempt, max_attempts, priority,
          scheduled_at, started_at, finished_at, duration_ms,
          payload_json, result_json, error_message,
          triggered_by, triggered_tick_id, created_at, updated_at
        ) VALUES (
          @id, @kind, @accountId, @status, @attempt, @maxAttempts, @priority,
          @scheduledAt, @startedAt, @finishedAt, @durationMs,
          @payloadJson, @resultJson, @errorMessage,
          @triggeredBy, @triggeredTickId, @createdAt, @updatedAt
        )
      `
      )
      .run(parsed);
    return parsed;
  }

  /** 取下一个待处理 job：status=queued AND scheduled_at ≤ now，按 priority,scheduled_at 排序。 */
  claimNextAccountJob(
    now: string = new Date().toISOString(),
    opts?: { excludeKinds?: string[] }
  ): AccountJob | undefined {
    // excludeKinds：调用方(worker)用它实现"agent 类 job 单飞"——已有一个登录/注册在跑时，
    // 排除掉 codex_login/codex_register，只放行 import 等非 agent 类 job 并发。
    const exclude = opts?.excludeKinds ?? [];
    const placeholders = exclude.map((_, i) => `@k${i}`).join(", ");
    const where = exclude.length
      ? `status = 'queued' AND scheduled_at <= @now AND kind NOT IN (${placeholders})`
      : `status = 'queued' AND scheduled_at <= @now`;
    const params: Record<string, unknown> = { now };
    exclude.forEach((k, i) => {
      params[`k${i}`] = k;
    });
    const row = this.sqlite
      .prepare(
        `SELECT * FROM account_jobs
         WHERE ${where}
         ORDER BY priority ASC, scheduled_at ASC LIMIT 1`
      )
      .get(params) as AccountJobRow | undefined;
    if (!row) return undefined;
    return accountJobFromRow(row);
  }

  updateAccountJob(
    id: string,
    patch: Partial<{
      status: AccountJobStatus;
      attempt: number;
      startedAt: string | null;
      finishedAt: string | null;
      durationMs: number | null;
      resultJson: string | null;
      errorMessage: string | null;
      logTail: string | null;
    }>
  ): AccountJob | undefined {
    const fieldMap: Record<keyof typeof patch, string> = {
      status: "status",
      attempt: "attempt",
      startedAt: "started_at",
      finishedAt: "finished_at",
      durationMs: "duration_ms",
      resultJson: "result_json",
      errorMessage: "error_message",
      logTail: "log_tail"
    };
    const sets: string[] = [];
    const values: Record<string, unknown> = {};
    for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
      const col = fieldMap[key];
      if (!col) continue;
      sets.push(`${col} = @${key}`);
      values[key] = patch[key] ?? null;
    }
    if (sets.length === 0) return this.getAccountJob(id);
    sets.push("updated_at = @updatedAt");
    values.updatedAt = new Date().toISOString();
    values.id = id;
    this.sqlite.prepare(`UPDATE account_jobs SET ${sets.join(", ")} WHERE id = @id`).run(values);
    return this.getAccountJob(id);
  }

  getAccountJob(id: string): AccountJob | undefined {
    const row = this.sqlite.prepare("SELECT * FROM account_jobs WHERE id = ?").get(id) as AccountJobRow | undefined;
    return row ? accountJobFromRow(row) : undefined;
  }

  listAccountJobs(limit = 100): AccountJob[] {
    const rows = this.sqlite
      .prepare("SELECT * FROM account_jobs ORDER BY created_at DESC LIMIT ?")
      .all(limit) as AccountJobRow[];
    return rows.map(accountJobFromRow);
  }

  countRunningAccountJobs(): number {
    return (this.sqlite.prepare("SELECT COUNT(*) AS c FROM account_jobs WHERE status = 'running'").get() as { c: number })
      .c;
  }

  /** 删除单个 job（P6-14：执行前发现 stale 任务时直接删，不留 cancelled 墓碑）。 */
  deleteAccountJob(id: string): boolean {
    return this.sqlite.prepare("DELETE FROM account_jobs WHERE id = ?").run(id).changes > 0;
  }

  /**
   * 删除某账号所有 queued job（P5-AV/P6-14）。账号退役 / 判定不可用时调用，清掉残留的
   * 重复 codex_login。P6-14：直接删除而非标 cancelled —— 这些是运维清理，不该留墓碑
   * 污染"最近完成"/堆积 DB。返回删除条数。
   */
  cancelQueuedJobsForAccount(accountId: string, _reason = ""): number {
    return this.sqlite
      .prepare("DELETE FROM account_jobs WHERE account_id = ? AND status = 'queued'")
      .run(accountId).changes;
  }

  /** 一次性清理：删除所有"账号已退役"的 queued 恢复 job（P5-AV/P6-14）。worker 启动时调用。 */
  cancelQueuedJobsForRetiredAccounts(): number {
    return this.sqlite
      .prepare(
        `DELETE FROM account_jobs
         WHERE status = 'queued'
           AND kind IN ('codex_login','codex_register')
           AND account_id IN (SELECT id FROM accounts WHERE intent = 'retired')`
      )
      .run().changes;
  }

  /**
   * 删除所有 queued 的恢复类 job（P5-AW "重新编排"/P6-14）。不动 running。返回删除条数。
   * 之后由调用方触发一次新 tick 重新规划。
   */
  cancelAllQueuedRecoveryJobs(_reason = ""): number {
    return this.sqlite
      .prepare("DELETE FROM account_jobs WHERE status = 'queued' AND kind IN ('codex_login','codex_register')")
      .run().changes;
  }

  /** 一次性清理：删除已是终态(cancelled)的运维墓碑记录（P6-14），清掉历史积压噪音。 */
  deleteCancelledJobs(): number {
    return this.sqlite.prepare("DELETE FROM account_jobs WHERE status = 'cancelled'").run().changes;
  }

  /**
   * 去重历史堆积的 queued 恢复 job（P5-AV/P6-14）：每个账号只保留最先会被认领的一条
   * (priority↑, scheduled_at↑)，其余直接删除。返回删除条数。
   */
  dedupeQueuedRecoveryJobs(): number {
    return this.sqlite
      .prepare(
        `DELETE FROM account_jobs
         WHERE status='queued' AND kind IN ('codex_login','codex_register') AND account_id IS NOT NULL
           AND id NOT IN (
             SELECT id FROM (
               SELECT id, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY priority ASC, scheduled_at ASC) AS rn
               FROM account_jobs
               WHERE status='queued' AND kind IN ('codex_login','codex_register') AND account_id IS NOT NULL
             ) WHERE rn = 1
           )`
      )
      .run().changes;
  }

  /** 当前有 queued 或 running job 的账号 id 集合（P5-AV：调度器据此去重，避免重复入队）。 */
  accountIdsWithPendingJobs(): Set<string> {
    const rows = this.sqlite
      .prepare(
        "SELECT DISTINCT account_id FROM account_jobs WHERE account_id IS NOT NULL AND status IN ('queued','running')"
      )
      .all() as Array<{ account_id: string }>;
    return new Set(rows.map((r) => r.account_id));
  }

  /** 当前 status=running 的 job（最久的排前面，便于 UI 显示"进行中 + 已运行时长"）。 */
  listRunningAccountJobs(): AccountJob[] {
    const rows = this.sqlite
      .prepare("SELECT * FROM account_jobs WHERE status = 'running' ORDER BY started_at ASC")
      .all() as AccountJobRow[];
    return rows.map(accountJobFromRow);
  }

  countQueuedAccountJobs(): number {
    return (this.sqlite.prepare("SELECT COUNT(*) AS c FROM account_jobs WHERE status = 'queued'").get() as { c: number })
      .c;
  }

  /**
   * 最近"执行完"的 job（P5-AT）—— 按 finished_at 倒序，仅 succeeded/failed/cancelled。
   * 区别于 listAccountJobs（按 created_at，会被一堆刚入队的 queued 淹没，看不到执行结果）。
   */
  listRecentFinishedAccountJobs(limit = 30): AccountJob[] {
    // P6-14：含 cancelled —— 不隐藏。运维清理已改为"直接删除"不再产生 cancelled 墓碑，
    // 所以这里出现的 cancelled 必是真实取消，应当暴露而非掩盖（免得忽视真问题）。
    const rows = this.sqlite
      .prepare(
        "SELECT * FROM account_jobs WHERE status IN ('succeeded','failed','cancelled') AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT ?"
      )
      .all(limit) as AccountJobRow[];
    return rows.map(accountJobFromRow);
  }

  /** 最近失败 job 的错误消息（P6-05：用于聚合失败原因，窗口内取样）。 */
  listRecentFailureMessages(limit = 150): string[] {
    const rows = this.sqlite
      .prepare(
        "SELECT error_message FROM account_jobs WHERE status = 'failed' AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT ?"
      )
      .all(limit) as Array<{ error_message: string | null }>;
    return rows.map((r) => r.error_message ?? "");
  }

  /**
   * worker 启动时调用：把上一进程残留的 running job 重置回 queued。
   *
   * 背景：worker 的并发计数是内存态（重启归零），但 DB 里被前一进程标成 running 的
   * job 不会自动复原 —— 进程没了它们却永远卡在 running，既污染"进行中"视图，又永远
   * 不会被重新认领。每次容器重建都会积累一批这种僵尸。
   *
   * 重置为 queued（清掉 started_at，保留已自增的 attempt）让它们重新进入认领队列；
   * codex_login 这类幂等重试本来就允许再跑一次。返回被重置的条数。
   */
  resetStaleRunningAccountJobs(): number {
    const now = new Date().toISOString();
    return this.sqlite
      .prepare(
        "UPDATE account_jobs SET status = 'queued', started_at = NULL, updated_at = ? WHERE status = 'running'"
      )
      .run(now).changes;
  }

  pruneAccountJobs(keepDays = 14): number {
    const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();
    return this.sqlite
      .prepare(
        "DELETE FROM account_jobs WHERE status IN ('succeeded', 'failed', 'cancelled') AND finished_at IS NOT NULL AND finished_at < ?"
      )
      .run(cutoff).changes;
  }

  // —— Account Fleet Ticks ——

  appendAccountFleetTick(tick: AccountFleetTick): void {
    const parsed = accountFleetTickSchema.parse(tick);
    this.sqlite
      .prepare(
        `
        INSERT INTO account_fleet_ticks (
          id, started_at, finished_at, duration_ms, enabled,
          skipped_reason, error_message, planned_total, applied_total,
          observed_json, planned_actions_json, applied_actions_json, triggered_job_ids_json
        ) VALUES (
          @id, @startedAt, @finishedAt, @durationMs, @enabled,
          @skippedReason, @errorMessage, @plannedTotal, @appliedTotal,
          @observedJson, @plannedActionsJson, @appliedActionsJson, @triggeredJobIdsJson
        )
      `
      )
      .run({
        id: parsed.id,
        startedAt: parsed.startedAt,
        finishedAt: parsed.finishedAt,
        durationMs: parsed.durationMs,
        enabled: parsed.enabled ? 1 : 0,
        skippedReason: parsed.skippedReason,
        errorMessage: parsed.errorMessage ?? null,
        plannedTotal: parsed.plannedTotal,
        appliedTotal: parsed.appliedTotal,
        observedJson: JSON.stringify(parsed.observed),
        plannedActionsJson: JSON.stringify(parsed.plannedActions),
        appliedActionsJson: JSON.stringify(parsed.appliedActions),
        triggeredJobIdsJson: JSON.stringify(parsed.triggeredJobIds)
      });
  }

  getAccountFleetTick(id: string): AccountFleetTick | undefined {
    const row = this.sqlite.prepare("SELECT * FROM account_fleet_ticks WHERE id = ?").get(id) as
      | AccountFleetTickRow
      | undefined;
    return row ? accountFleetTickFromRow(row) : undefined;
  }

  listRecentAccountFleetTickSummaries(limit = 50): AccountFleetTickSummary[] {
    const rows = this.sqlite
      .prepare(
        "SELECT id, started_at, finished_at, duration_ms, enabled, planned_total, applied_total, skipped_reason, error_message FROM account_fleet_ticks ORDER BY started_at DESC LIMIT ?"
      )
      .all(limit) as Array<{
      id: string;
      started_at: string;
      finished_at: string;
      duration_ms: number;
      enabled: number;
      planned_total: number;
      applied_total: number;
      skipped_reason: AccountFleetTick["skippedReason"];
      error_message: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      enabled: Boolean(row.enabled),
      plannedTotal: row.planned_total,
      appliedTotal: row.applied_total,
      skippedReason: normalizeLegacySkippedReason(row.skipped_reason),
      ...(row.error_message ? { errorMessage: row.error_message } : {})
    }));
  }

  listRecentAccountFleetTicks(limit = 20): AccountFleetTick[] {
    const rows = this.sqlite
      .prepare("SELECT * FROM account_fleet_ticks ORDER BY started_at DESC LIMIT ?")
      .all(limit) as AccountFleetTickRow[];
    return rows.map(accountFleetTickFromRow);
  }

  pruneAccountFleetTicks(keepDays = 7): number {
    const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();
    return this.sqlite.prepare("DELETE FROM account_fleet_ticks WHERE started_at < ?").run(cutoff).changes;
  }

  // —— Account Budgets ——

  getAccountBudget(windowKey: string): AccountBudgetRecord | undefined {
    const row = this.sqlite
      .prepare("SELECT * FROM account_budgets WHERE window_key = ?")
      .get(windowKey) as AccountBudgetRow | undefined;
    return row ? accountBudgetFromRow(row) : undefined;
  }

  upsertAccountBudget(record: AccountBudgetRecord): AccountBudgetRecord {
    const parsed = accountBudgetRecordSchema.parse(record);
    this.sqlite
      .prepare(
        `
        INSERT INTO account_budgets (window_key, registrations_used, registrations_budget, sms_cost_cents, reset_at, updated_at)
        VALUES (@windowKey, @registrationsUsed, @registrationsBudget, @smsCostCents, @resetAt, @updatedAt)
        ON CONFLICT(window_key) DO UPDATE SET
          registrations_used = excluded.registrations_used,
          registrations_budget = excluded.registrations_budget,
          sms_cost_cents = excluded.sms_cost_cents,
          reset_at = excluded.reset_at,
          updated_at = excluded.updated_at
      `
      )
      .run(parsed);
    return parsed;
  }

  /** 原子递增预算计数器；如果 window 不存在则建立。 */
  incrementBudgetUsage(input: {
    windowKey: string;
    registrationsBudget: number;
    resetAt: string;
    deltaRegistrations: number;
    deltaSmsCostCents?: number;
  }): AccountBudgetRecord {
    const now = new Date().toISOString();
    const transaction = this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `
          INSERT INTO account_budgets (window_key, registrations_used, registrations_budget, sms_cost_cents, reset_at, updated_at)
          VALUES (@windowKey, @deltaRegistrations, @registrationsBudget, @deltaSms, @resetAt, @now)
          ON CONFLICT(window_key) DO UPDATE SET
            registrations_used = registrations_used + @deltaRegistrations,
            sms_cost_cents = sms_cost_cents + @deltaSms,
            registrations_budget = @registrationsBudget,
            updated_at = @now
        `
        )
        .run({
          windowKey: input.windowKey,
          deltaRegistrations: input.deltaRegistrations,
          deltaSms: input.deltaSmsCostCents ?? 0,
          registrationsBudget: input.registrationsBudget,
          resetAt: input.resetAt,
          now
        });
    });
    transaction();
    const result = this.getAccountBudget(input.windowKey);
    if (!result) {
      throw new Error(`Budget window not found after upsert: ${input.windowKey}`);
    }
    return result;
  }
}

function subscriptionFromRow(row: SubscriptionRow): SubscriptionSource {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    value: row.value,
    enabled: Boolean(row.enabled),
    ...(row.last_content ? { lastContent: row.last_content } : {}),
    excludeKeywords: parseKeywords(row.exclude_keywords),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseKeywords(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return normalizeKeywords(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return [];
  }
}

function normalizeKeywords(values: string[]): string[] {
  return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)));
}

function nodeFromRow(row: NodeRow): ProxyNode {
  return {
    hash: row.hash,
    sourceId: row.source_id,
    name: row.name,
    originalName: row.original_name,
    type: row.type,
    region: row.region,
    raw: JSON.parse(row.raw_json) as Record<string, unknown>,
    status: row.status,
    lifecycleStatus: row.lifecycle_status ?? lifecycleFromStatus(row.status),
    schedulable: Boolean(row.schedulable),
    protected: Boolean(row.protected),
    ...(row.sub2api_proxy_id ? { sub2apiProxyId: row.sub2api_proxy_id } : {}),
    ...(row.quality_score === null ? {} : { qualityScore: row.quality_score }),
    ...(row.assigned_port ? { assignedPort: row.assigned_port } : {}),
    ...(row.last_test_status ? { lastTestStatus: row.last_test_status } : {}),
    ...(row.last_test_latency_ms ? { lastTestLatencyMs: row.last_test_latency_ms } : {}),
    ...(row.last_test_targets ? { lastTestTargets: row.last_test_targets } : {}),
    intentRole: row.intent_role ?? intentFromLifecycle(row.lifecycle_status),
    backoffUntil: row.backoff_until,
    backoffAttempts: row.backoff_attempts ?? 0,
    healthScore: row.health_score,
    lastHealthCheck: row.last_health_check,
    codexLoginSuccess: row.codex_login_success ?? 0,
    codexLoginFailure: row.codex_login_failure ?? 0,
    codexRegisterSuccess: row.codex_register_success ?? 0,
    codexRegisterFailure: row.codex_register_failure ?? 0,
    codexLastOutcome: row.codex_last_outcome,
    codexLastOutcomeAt: row.codex_last_outcome_at,
    codexReserved: Boolean(row.codex_reserved),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function intentFromLifecycle(lifecycle: NodeLifecycleStatus): NodeIntentRole {
  switch (lifecycle) {
    case "schedulable":
      return "serving";
    case "candidate":
    case "testing":
      return "standby";
    case "disabled":
      return "paused";          // 用户暂停 → 账号留原地
    case "cooling_down":
    case "draining":
    case "retired":
    case "deleted":
      return "evicted";          // 下线意图 → 账号迁走
    default:
      return "standby";
  }
}

function reconcileTickFromRow(row: ReconcileTickRow): ReconcileTick {
  return reconcileTickSchema.parse({
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    enabled: Boolean(row.enabled),
    skippedReason: row.skipped_reason,
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    plannedTotal: row.planned_total,
    appliedTotal: row.applied_total,
    observedSummary: JSON.parse(row.observed_json),
    nodeIntents: JSON.parse(row.node_intents_json),
    plannedChanges: JSON.parse(row.planned_changes_json),
    appliedChanges: JSON.parse(row.applied_changes_json),
    ...(row.operation_id ? { operationId: row.operation_id } : {})
  });
}

function lifecycleFromStatus(status: ProxyNode["status"]): NodeLifecycleStatus {
  switch (status) {
    case "active":
      return "schedulable";
    case "inactive":
      return "disabled";
    case "failed":
      return "cooling_down";
    case "untested":
      return "candidate";
    default:
      return "candidate";
  }
}

function toAccountRow(record: AccountRecordInternal): Record<string, unknown> {
  return {
    id: record.id,
    externalId: record.externalId,
    origin: record.origin,
    intent: record.intent,
    health: record.health,
    email: record.email,
    organizationId: record.organizationId,
    clientId: record.clientId,
    platform: record.platform,
    type: record.type,
    encPhone: record.encPhone,
    encPassword: record.encPassword,
    encRefreshToken: record.encRefreshToken,
    encAccessToken: record.encAccessToken,
    encIdToken: record.encIdToken,
    encRecoveryInputJson: record.encRecoveryInputJson,
    lastObservedAt: record.lastObservedAt,
    lastUsedAt: record.lastUsedAt,
    rateLimitedAt: record.rateLimitedAt,
    rateLimitResetAt: record.rateLimitResetAt,
    quota5hPercent: record.quota5hPercent,
    quota7dPercent: record.quota7dPercent,
    errorsInWindow: record.errorsInWindow,
    brokenSinceTick: record.brokenSinceTick,
    brokenConsecutiveTicks: record.brokenConsecutiveTicks,
    recoveryAttempts: record.recoveryAttempts,
    nextRecoveryAfter: record.nextRecoveryAfter,
    lastRecoveryError: record.lastRecoveryError,
    lastRecoveryPath: record.lastRecoveryPath,
    lastRecoveryFailureCategory: record.lastRecoveryFailureCategory,
    opsEnabled: record.opsEnabled ? 1 : 0,
    herosmsActivationId: record.herosmsActivationId ?? null,
    batchId: record.batchId,
    registeredAt: record.registeredAt,
    smsCountry: record.smsCountry,
    smsCostCents: record.smsCostCents,
    egressNodeHash: record.egressNodeHash,
    firstSeenAt: record.firstSeenAt,
    reloginCount: record.reloginCount,
    lastRecoveredAt: record.lastRecoveredAt,
    changeHistory:
      record.changeHistory && record.changeHistory.length > 0 ? JSON.stringify(record.changeHistory) : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

/** 从账号记录抽出参与变更 diff 的字段快照。 */
function changeSnapshot(a: AccountRecordInternal): AccountChangeSnapshot {
  return {
    health: a.health,
    intent: a.intent,
    quota5hPercent: a.quota5hPercent,
    quota7dPercent: a.quota7dPercent
  };
}

/** 解析 change_history JSON 列；缺失 / 损坏 → 空数组（不阻断账号读取）。 */
function parseChangeHistory(raw: string | null): AccountChangeEntry[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as AccountChangeEntry[]) : [];
  } catch {
    return [];
  }
}

function accountFromRow(row: AccountRow): AccountRecordInternal {
  return accountRecordInternalSchema.parse({
    id: row.id,
    externalId: row.external_id,
    origin: row.origin,
    intent: row.intent,
    health: row.health,
    email: row.email,
    organizationId: row.organization_id,
    clientId: row.client_id,
    platform: row.platform,
    type: row.type,
    encPhone: row.enc_phone,
    encPassword: row.enc_password,
    encRefreshToken: row.enc_refresh_token,
    encAccessToken: row.enc_access_token,
    encIdToken: row.enc_id_token,
    encRecoveryInputJson: row.enc_recovery_input_json,
    lastObservedAt: row.last_observed_at,
    lastUsedAt: row.last_used_at,
    rateLimitedAt: row.rate_limited_at,
    rateLimitResetAt: row.rate_limit_reset_at,
    quota5hPercent: row.quota_5h_percent,
    quota7dPercent: row.quota_7d_percent,
    errorsInWindow: row.errors_in_window,
    brokenSinceTick: row.broken_since_tick,
    brokenConsecutiveTicks: row.broken_consecutive_ticks,
    recoveryAttempts: row.recovery_attempts,
    nextRecoveryAfter: row.next_recovery_after,
    lastRecoveryError: row.last_recovery_error,
    lastRecoveryPath: row.last_recovery_path,
    lastRecoveryFailureCategory: row.last_recovery_failure_category,
    opsEnabled: (row.ops_enabled ?? 1) === 1,
    herosmsActivationId: row.herosms_activation_id ?? null,
    batchId: row.batch_id,
    registeredAt: row.registered_at,
    smsCountry: row.sms_country,
    smsCostCents: row.sms_cost_cents,
    egressNodeHash: row.egress_node_hash,
    firstSeenAt: row.first_seen_at,
    reloginCount: row.relogin_count,
    lastRecoveredAt: row.last_recovered_at,
    changeHistory: parseChangeHistory(row.change_history),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function accountJobFromRow(row: AccountJobRow): AccountJob {
  return accountJobSchema.parse({
    id: row.id,
    kind: row.kind,
    accountId: row.account_id,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    priority: row.priority,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    payloadJson: row.payload_json,
    resultJson: row.result_json,
    errorMessage: row.error_message,
    logTail: row.log_tail ?? null,
    triggeredBy: row.triggered_by,
    triggeredTickId: row.triggered_tick_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

/**
 * 兼容旧 tick 数据：早期实现写过 skipped_reason='dry_run'，新 schema 已删除
 * 该枚举。把 legacy 'dry_run' 读出来时归一化成 'paused'（语义上等价：scheduler
 * 没真入队 jobs）。其它值原样透传，让 Zod 抓真正的 schema mismatch。
 */
function normalizeLegacySkippedReason(value: string): AccountFleetTick["skippedReason"] {
  if (value === "dry_run") return "paused";
  return value as AccountFleetTick["skippedReason"];
}

function accountFleetTickFromRow(row: AccountFleetTickRow): AccountFleetTick {
  return accountFleetTickSchema.parse({
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    enabled: Boolean(row.enabled),
    skippedReason: normalizeLegacySkippedReason(row.skipped_reason),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    plannedTotal: row.planned_total,
    appliedTotal: row.applied_total,
    observed: JSON.parse(row.observed_json),
    plannedActions: JSON.parse(row.planned_actions_json),
    appliedActions: JSON.parse(row.applied_actions_json),
    triggeredJobIds: JSON.parse(row.triggered_job_ids_json)
  });
}

function accountBudgetFromRow(row: AccountBudgetRow): AccountBudgetRecord {
  return accountBudgetRecordSchema.parse({
    windowKey: row.window_key,
    registrationsUsed: row.registrations_used,
    registrationsBudget: row.registrations_budget,
    smsCostCents: row.sms_cost_cents,
    resetAt: row.reset_at,
    updatedAt: row.updated_at
  });
}

function statusFromLifecycle(lifecycleStatus: NodeLifecycleStatus): ProxyNode["status"] {
  switch (lifecycleStatus) {
    case "schedulable":
      return "active";
    case "cooling_down":
      return "failed";
    case "candidate":
    case "testing":
      return "untested";
    case "disabled":
    case "draining":
    case "retired":
    case "deleted":
      return "inactive";
    default:
      return "inactive";
  }
}
