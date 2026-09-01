import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type HiveSqlite = Database.Database;
export type HiveDb = ReturnType<typeof drizzle<typeof schema>>;

export function openSqlite(path: string): HiveSqlite {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  ensureSchema(sqlite);
  return sqlite;
}

export function openDrizzle(path: string): { sqlite: HiveSqlite; db: HiveDb } {
  const sqlite = openSqlite(path);
  return {
    sqlite,
    db: drizzle(sqlite, { schema })
  };
}

function ensureSchema(sqlite: HiveSqlite): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('url', 'file')),
      value TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_content TEXT,
      exclude_keywords TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nodes (
      hash TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      name TEXT NOT NULL,
      original_name TEXT NOT NULL,
      type TEXT NOT NULL,
      region TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'direct' CHECK (kind IN ('direct', 'chain')),
      chain_json TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'untested', 'failed')),
      lifecycle_status TEXT NOT NULL DEFAULT 'candidate' CHECK (lifecycle_status IN ('candidate', 'testing', 'schedulable', 'disabled', 'draining', 'cooling_down', 'retired', 'deleted')),
      schedulable INTEGER NOT NULL DEFAULT 0,
      protected INTEGER NOT NULL DEFAULT 0,
      sub2api_proxy_id INTEGER,
      quality_score INTEGER,
      assigned_port INTEGER,
      last_test_status TEXT,
      last_test_latency_ms INTEGER,
      last_test_targets TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reconcile_ticks (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      enabled INTEGER NOT NULL,
      skipped_reason TEXT NOT NULL,
      error_message TEXT,
      planned_total INTEGER NOT NULL DEFAULT 0,
      applied_total INTEGER NOT NULL DEFAULT 0,
      observed_json TEXT NOT NULL,
      node_intents_json TEXT NOT NULL,
      planned_changes_json TEXT NOT NULL,
      applied_changes_json TEXT NOT NULL,
      operation_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_reconcile_ticks_started_at
      ON reconcile_ticks(started_at DESC);

    -- ─── Account Fleet (notes/account-fleet-design.md) ───────────
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      external_id INTEGER,
      origin TEXT NOT NULL DEFAULT 'adopted_active'
        CHECK (origin IN ('hive_registered', 'adopted_active', 'adopted_recovered', 'adopted_observing', 'retired_legacy')),
      intent TEXT NOT NULL DEFAULT 'active'
        CHECK (intent IN ('pending', 'active', 'recovering', 'retired')),
      health TEXT NOT NULL DEFAULT 'unknown'
        CHECK (health IN ('healthy', 'rate_limited', 'quota_exhausted', 'broken', 'unknown')),
      email TEXT NOT NULL,
      organization_id TEXT,
      client_id TEXT,
      platform TEXT NOT NULL DEFAULT 'openai',
      type TEXT NOT NULL DEFAULT 'oauth',
      enc_phone TEXT,
      enc_password TEXT,
      enc_refresh_token TEXT,
      enc_access_token TEXT,
      enc_id_token TEXT,
      enc_recovery_input_json TEXT,
      last_observed_at TEXT,
      last_used_at TEXT,
      rate_limited_at TEXT,
      rate_limit_reset_at TEXT,
      quota_5h_percent INTEGER,
      quota_7d_percent INTEGER,
      errors_in_window INTEGER NOT NULL DEFAULT 0,
      broken_since_tick TEXT,
      broken_consecutive_ticks INTEGER NOT NULL DEFAULT 0,
      recovery_attempts INTEGER NOT NULL DEFAULT 0,
      next_recovery_after TEXT,
      last_recovery_error TEXT,
      last_recovery_path TEXT
        CHECK (last_recovery_path IS NULL OR last_recovery_path IN ('codex_login', 'codex_register')),
      last_recovery_failure_category TEXT
        CHECK (last_recovery_failure_category IS NULL
               OR last_recovery_failure_category IN ('account_unusable', 'network_or_proxy', 'oauth_failed')),
      batch_id TEXT,
      registered_at TEXT,
      sms_country TEXT,
      sms_cost_cents INTEGER,
      egress_node_hash TEXT,
      first_seen_at TEXT,
      relogin_count INTEGER NOT NULL DEFAULT 0,
      last_recovered_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_external_id
      ON accounts(external_id) WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_accounts_origin_intent_health
      ON accounts(origin, intent, health);
    CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
    CREATE INDEX IF NOT EXISTS idx_accounts_next_recovery
      ON accounts(next_recovery_after);

    CREATE TABLE IF NOT EXISTS account_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL
        CHECK (kind IN ('codex_login', 'codex_register', 'import_to_sub2api',
                        'import_codex_tool_account',
                        'delete_sub2api', 'toggle_schedulable', 'observe_usage')),
      account_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      attempt INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 100,
      scheduled_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER,
      payload_json TEXT NOT NULL,
      result_json TEXT,
      error_message TEXT,
      triggered_by TEXT NOT NULL DEFAULT 'scheduler'
        CHECK (triggered_by IN ('scheduler', 'manual', 'adopter')),
      triggered_tick_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_account_jobs_dispatch
      ON account_jobs(status, scheduled_at, priority);
    CREATE INDEX IF NOT EXISTS idx_account_jobs_account
      ON account_jobs(account_id);
    CREATE INDEX IF NOT EXISTS idx_account_jobs_tick
      ON account_jobs(triggered_tick_id);

    CREATE TABLE IF NOT EXISTS account_fleet_ticks (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      enabled INTEGER NOT NULL,
      skipped_reason TEXT NOT NULL,
      error_message TEXT,
      planned_total INTEGER NOT NULL DEFAULT 0,
      applied_total INTEGER NOT NULL DEFAULT 0,
      observed_json TEXT NOT NULL,
      planned_actions_json TEXT NOT NULL,
      applied_actions_json TEXT NOT NULL,
      triggered_job_ids_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_account_fleet_ticks_started_at
      ON account_fleet_ticks(started_at DESC);

    CREATE TABLE IF NOT EXISTS account_budgets (
      window_key TEXT PRIMARY KEY,
      registrations_used INTEGER NOT NULL DEFAULT 0,
      registrations_budget INTEGER NOT NULL,
      sms_cost_cents INTEGER NOT NULL DEFAULT 0,
      reset_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  addColumnIfMissing(sqlite, "subscriptions", "exclude_keywords", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(sqlite, "nodes", "lifecycle_status", "TEXT NOT NULL DEFAULT 'candidate'");
  addColumnIfMissing(sqlite, "nodes", "schedulable", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(sqlite, "nodes", "protected", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(sqlite, "nodes", "kind", "TEXT NOT NULL DEFAULT 'direct'");
  addColumnIfMissing(sqlite, "nodes", "chain_json", "TEXT");
  addColumnIfMissing(sqlite, "nodes", "sub2api_proxy_id", "INTEGER");
  addColumnIfMissing(sqlite, "nodes", "quality_score", "INTEGER");
  // ADR 0003: orchestration intent columns
  addColumnIfMissing(sqlite, "nodes", "intent_role", "TEXT NOT NULL DEFAULT 'standby'");
  addColumnIfMissing(sqlite, "nodes", "backoff_until", "TEXT");
  addColumnIfMissing(sqlite, "nodes", "backoff_attempts", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(sqlite, "nodes", "health_score", "INTEGER");
  addColumnIfMissing(sqlite, "nodes", "last_health_check", "TEXT");
  // P5-R: 每个测试目标（openai / claude / ...）的独立结果，JSON 数组字符串
  addColumnIfMissing(sqlite, "nodes", "last_test_targets", "TEXT");
  // P5-AS: 节点 codex_login 实战反馈（能否过 Cloudflare Sentinel，区别于 openai 连通性测试）
  addColumnIfMissing(sqlite, "nodes", "codex_login_success", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(sqlite, "nodes", "codex_login_failure", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(sqlite, "nodes", "codex_last_outcome", "TEXT");
  addColumnIfMissing(sqlite, "nodes", "codex_last_outcome_at", "TEXT");
  // P5-AS: 保留节点标记（专用于注册/登录的高质量备用出口）
  addColumnIfMissing(sqlite, "nodes", "codex_reserved", "INTEGER NOT NULL DEFAULT 0");
  // P5-BB: 注册战绩与登录分开统计（能注册 ≠ 能登录）。登录选节点只看 codex_login_*。
  addColumnIfMissing(sqlite, "nodes", "codex_register_success", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(sqlite, "nodes", "codex_register_failure", "INTEGER NOT NULL DEFAULT 0");
  // 一次性重置被"Linux 容器环境坏掉那段时间"污染的登录战绩 —— 那时每个节点登录都失败,
  // 把计数刷爆、连能登录的节点也埋成负分。外置 agent 修复环境后,登录战绩需重新学习。
  // settings flag 守卫,只跑一次;此后新累计的登录战绩保留不动。
  const loginResetFlag = sqlite
    .prepare("SELECT 1 FROM settings WHERE key = ?")
    .get("migrations.codex_login_stats_reset_v1");
  if (!loginResetFlag) {
    sqlite.exec("UPDATE nodes SET codex_login_success = 0, codex_login_failure = 0;");
    sqlite
      .prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO NOTHING")
      .run("migrations.codex_login_stats_reset_v1", JSON.stringify({ at: "migration" }));
  }
  // 一次性数据修复：把"按 network_or_proxy(出口/consent/Sentinel 类，非账号死)退役"的
  // 账号捞回 recovering。背景：consent 失败过去归 network_or_proxy 并在重试上限后退役，
  // 把大量**活账号**(过了 OpenAI OTP、只是我方出口过不了 consent)误判成死号。退役从此
  // 只留给 OpenAI 确认的 account_unusable。捞回时设 6h 后再试，避免一次性涌入猛打 Sentinel。
  // settings flag 守卫，只跑一次。
  const reviveFlag = sqlite
    .prepare("SELECT 1 FROM settings WHERE key = ?")
    .get("migrations.revive_network_retired_v1");
  if (!reviveFlag) {
    const sixHoursLater = new Date(Date.now() + 6 * 3_600_000).toISOString();
    const res = sqlite
      .prepare(
        "UPDATE accounts SET intent = 'recovering', recovery_attempts = 4, next_recovery_after = ? " +
          "WHERE intent = 'retired' AND last_recovery_failure_category = 'network_or_proxy'"
      )
      .run(sixHoursLater);
    sqlite
      .prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO NOTHING")
      .run("migrations.revive_network_retired_v1", JSON.stringify({ at: "migration", revived: res.changes }));
    if (res.changes > 0) {
      console.log(`[migration] 捞回 ${res.changes} 个按 network_or_proxy 误退役的账号 → recovering(6h 后再试)。`);
    }
  }
  // 一次性测试推动：让一小批"很可能还活着"(上次失败归 network_or_proxy = 过了 OpenAI
  // OTP、只是出口过不了 consent)的 recovering 账号立刻可重试,用来观测"经干净出口
  // (192.168.5.8) 登录成功率是否回升"。封顶 20 个,避免单 IP 被连续登录打到限流;其余
  // 账号维持 6h 退避不动。settings flag 守卫,只跑一次。
  const sampleFlag = sqlite
    .prepare("SELECT 1 FROM settings WHERE key = ?")
    .get("migrations.test_login_egress_sample_v1");
  if (!sampleFlag) {
    const res = sqlite
      .prepare(
        "UPDATE accounts SET next_recovery_after = ? WHERE id IN (" +
          "SELECT id FROM accounts WHERE intent = 'recovering' AND last_recovery_failure_category = 'network_or_proxy' " +
          "ORDER BY last_used_at DESC LIMIT 20)"
      )
      .run(new Date().toISOString());
    sqlite
      .prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO NOTHING")
      .run("migrations.test_login_egress_sample_v1", JSON.stringify({ at: "migration", made_eligible: res.changes }));
    if (res.changes > 0) {
      console.log(`[migration] 放出 ${res.changes} 个活账号立即可重试(观测干净出口登录成功率)。`);
    }
  }
  // P5-AT: job 结束时持久化的日志末尾（redact 过），供"最近完成"回看
  addColumnIfMissing(sqlite, "account_jobs", "log_tail", "TEXT");
  // notes/account-fleet-design.md proxy-aware orchestration（增量 migration）：
  // 旧 accounts 表升级时补 egress_node_hash 字段
  addColumnIfMissing(sqlite, "accounts", "egress_node_hash", "TEXT");
  // P5-AI: 持久化 codex-tool 注册阶段返回的元信息（external-integration.md §"成本上限
  // 和选区策略" + §"OAuth 失败分类"）。三列都允许 NULL —— 老账号 / adopted 路径不会有。
  addColumnIfMissing(sqlite, "accounts", "sms_country", "TEXT");
  addColumnIfMissing(sqlite, "accounts", "sms_cost_cents", "INTEGER");
  addColumnIfMissing(sqlite, "accounts", "last_recovery_failure_category", "TEXT");
  // P5-AQ: 账号质量指标。first_seen_at 回填为 created_at（接管/创建时间）作首次时间兜底；
  // relogin_count 累计 codex_login 成功修复次数；last_recovered_at 最近一次修复成功时间。
  addColumnIfMissing(sqlite, "accounts", "first_seen_at", "TEXT");
  addColumnIfMissing(sqlite, "accounts", "relogin_count", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(sqlite, "accounts", "last_recovered_at", "TEXT");
  sqlite.exec("UPDATE accounts SET first_seen_at = created_at WHERE first_seen_at IS NULL;");
  // 变更历史（JSON 数组，最近 N 条 health/intent/额度变动；附加列，不回填存量）
  addColumnIfMissing(sqlite, "accounts", "change_history", "TEXT");
  // 运维开关：false=该账号暂停一切自动化(恢复/重绑)分配,用于隔离实验。默认 1(开)。
  addColumnIfMissing(sqlite, "accounts", "ops_enabled", "INTEGER NOT NULL DEFAULT 1");
  // hero-sms 激活 ID：登录被要求手机 OTP(step-up) 时用它对原号"重新激活"二次接码。
  addColumnIfMissing(sqlite, "accounts", "herosms_activation_id", "TEXT");
  // P5-AK/3: account_jobs.kind 加 import_codex_tool_account。SQLite 不能 ALTER CHECK，
  // 老 DB 必须 rebuild 表（rename → create → copy → drop → 重建 indexes）。
  rebuildAccountJobsCheckIfNeeded(sqlite);
  // Seed intent_role from lifecycle for nodes that pre-date this column.
  sqlite.exec(`
    UPDATE nodes
       SET intent_role = CASE
         WHEN lifecycle_status = 'schedulable' THEN 'serving'
         WHEN lifecycle_status IN ('disabled', 'candidate', 'testing') THEN 'standby'
         WHEN lifecycle_status IN ('cooling_down', 'draining') THEN 'quarantined'
         WHEN lifecycle_status IN ('retired', 'deleted') THEN 'evicted'
         ELSE intent_role
       END
     WHERE intent_role = 'standby' OR intent_role IS NULL;
  `);
  sqlite.exec(`
    UPDATE nodes
    SET lifecycle_status = CASE
      WHEN status = 'active' THEN 'schedulable'
      WHEN status = 'inactive' THEN 'disabled'
      WHEN status = 'failed' THEN 'cooling_down'
      ELSE lifecycle_status
    END
    WHERE lifecycle_status = 'candidate';

    UPDATE nodes
    SET schedulable = CASE WHEN lifecycle_status = 'schedulable' THEN 1 ELSE schedulable END;
  `);
}

/**
 * 重建 account_jobs 表，让 kind CHECK 接受新加的 'import_codex_tool_account'（P5-AK/3）。
 *
 * SQLite ALTER TABLE 不支持改 CHECK，只能 rename → create_new → copy → drop_old →
 * rename 回去。检测条件：用 sqlite_master 的 sql 字段判断 CHECK 是否含新 kind 字符串。
 * 已是新结构 → 跳过。
 */
function rebuildAccountJobsCheckIfNeeded(sqlite: HiveSqlite): void {
  const row = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='account_jobs'")
    .get() as { sql: string } | undefined;
  if (!row || !row.sql) return;
  if (row.sql.includes("import_codex_tool_account")) return; // 已是新结构

  sqlite.exec(`
    BEGIN TRANSACTION;
    ALTER TABLE account_jobs RENAME TO account_jobs_old;
    CREATE TABLE account_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL
        CHECK (kind IN ('codex_login', 'codex_register', 'import_to_sub2api',
                        'import_codex_tool_account',
                        'delete_sub2api', 'toggle_schedulable', 'observe_usage')),
      account_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      attempt INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 100,
      scheduled_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER,
      payload_json TEXT NOT NULL,
      result_json TEXT,
      error_message TEXT,
      triggered_by TEXT NOT NULL DEFAULT 'scheduler'
        CHECK (triggered_by IN ('scheduler', 'manual', 'adopter')),
      triggered_tick_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO account_jobs SELECT * FROM account_jobs_old;
    DROP TABLE account_jobs_old;
    CREATE INDEX IF NOT EXISTS idx_account_jobs_dispatch
      ON account_jobs(status, scheduled_at, priority);
    CREATE INDEX IF NOT EXISTS idx_account_jobs_account
      ON account_jobs(account_id);
    CREATE INDEX IF NOT EXISTS idx_account_jobs_tick
      ON account_jobs(triggered_tick_id);
    COMMIT;
  `);
}

function addColumnIfMissing(sqlite: HiveSqlite, table: string, column: string, definition: string): void {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!rows.some((row) => row.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
