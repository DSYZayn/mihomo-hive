import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const subscriptions = sqliteTable("subscriptions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["url", "file"] }).notNull(),
  value: text("value").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastContent: text("last_content"),
  excludeKeywords: text("exclude_keywords").notNull().default("[]"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const nodes = sqliteTable("nodes", {
  hash: text("hash").primaryKey(),
  sourceId: text("source_id").notNull(),
  name: text("name").notNull(),
  originalName: text("original_name").notNull(),
  type: text("type").notNull(),
  region: text("region").notNull(),
  rawJson: text("raw_json").notNull(),
  kind: text("kind", { enum: ["direct", "chain"] }).notNull().default("direct"),
  chainJson: text("chain_json"),
  status: text("status", { enum: ["active", "inactive", "untested", "failed"] }).notNull(),
  lifecycleStatus: text("lifecycle_status", {
    enum: ["candidate", "testing", "schedulable", "disabled", "draining", "cooling_down", "retired", "deleted"]
  })
    .notNull()
    .default("candidate"),
  schedulable: integer("schedulable", { mode: "boolean" }).notNull().default(false),
  protected: integer("protected", { mode: "boolean" }).notNull().default(false),
  sub2apiProxyId: integer("sub2api_proxy_id"),
  qualityScore: integer("quality_score"),
  assignedPort: integer("assigned_port"),
  lastTestStatus: text("last_test_status"),
  lastTestLatencyMs: integer("last_test_latency_ms"),
  lastTestTargets: text("last_test_targets"),
  // 编排意图（ADR 0003）
  intentRole: text("intent_role", { enum: ["serving", "standby", "quarantined", "evicted", "paused"] })
    .notNull()
    .default("standby"),
  backoffUntil: text("backoff_until"),
  backoffAttempts: integer("backoff_attempts").notNull().default(0),
  healthScore: integer("health_score"),
  lastHealthCheck: text("last_health_check"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const reconcileTicks = sqliteTable("reconcile_ticks", {
  id: text("id").primaryKey(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at").notNull(),
  durationMs: integer("duration_ms").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  skippedReason: text("skipped_reason").notNull(),
  errorMessage: text("error_message"),
  plannedTotal: integer("planned_total").notNull().default(0),
  appliedTotal: integer("applied_total").notNull().default(0),
  observedJson: text("observed_json").notNull(),
  nodeIntentsJson: text("node_intents_json").notNull(),
  plannedChangesJson: text("planned_changes_json").notNull(),
  appliedChangesJson: text("applied_changes_json").notNull(),
  operationId: text("operation_id")
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull()
});

export const authSessions = sqliteTable("auth_sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull()
});

// ─── Account Fleet (notes/account-fleet-design.md) ──────────────

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  externalId: integer("external_id"),
  origin: text("origin", {
    enum: ["hive_registered", "adopted_active", "adopted_recovered", "adopted_observing", "retired_legacy"]
  })
    .notNull()
    .default("adopted_active"),
  intent: text("intent", { enum: ["pending", "active", "recovering", "retired"] })
    .notNull()
    .default("active"),
  health: text("health", { enum: ["healthy", "rate_limited", "quota_exhausted", "broken", "unknown"] })
    .notNull()
    .default("unknown"),
  email: text("email").notNull(),
  organizationId: text("organization_id"),
  clientId: text("client_id"),
  platform: text("platform").notNull().default("openai"),
  type: text("type").notNull().default("oauth"),
  encPhone: text("enc_phone"),
  encPassword: text("enc_password"),
  encRefreshToken: text("enc_refresh_token"),
  encAccessToken: text("enc_access_token"),
  encIdToken: text("enc_id_token"),
  encRecoveryInputJson: text("enc_recovery_input_json"),
  lastObservedAt: text("last_observed_at"),
  lastUsedAt: text("last_used_at"),
  rateLimitedAt: text("rate_limited_at"),
  rateLimitResetAt: text("rate_limit_reset_at"),
  quota5hPercent: integer("quota_5h_percent"),
  quota7dPercent: integer("quota_7d_percent"),
  errorsInWindow: integer("errors_in_window").notNull().default(0),
  brokenSinceTick: text("broken_since_tick"),
  brokenConsecutiveTicks: integer("broken_consecutive_ticks").notNull().default(0),
  recoveryAttempts: integer("recovery_attempts").notNull().default(0),
  nextRecoveryAfter: text("next_recovery_after"),
  lastRecoveryError: text("last_recovery_error"),
  lastRecoveryPath: text("last_recovery_path", { enum: ["codex_login", "codex_register"] }),
  batchId: text("batch_id"),
  registeredAt: text("registered_at"),
  egressNodeHash: text("egress_node_hash"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const accountJobs = sqliteTable("account_jobs", {
  id: text("id").primaryKey(),
  kind: text("kind", {
    enum: ["codex_login", "codex_register", "import_to_sub2api", "delete_sub2api", "toggle_schedulable", "observe_usage"]
  }).notNull(),
  accountId: text("account_id"),
  status: text("status", { enum: ["queued", "running", "succeeded", "failed", "cancelled"] })
    .notNull()
    .default("queued"),
  attempt: integer("attempt").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(1),
  priority: integer("priority").notNull().default(100),
  scheduledAt: text("scheduled_at").notNull(),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  durationMs: integer("duration_ms"),
  payloadJson: text("payload_json").notNull(),
  resultJson: text("result_json"),
  errorMessage: text("error_message"),
  triggeredBy: text("triggered_by", { enum: ["scheduler", "manual", "adopter"] })
    .notNull()
    .default("scheduler"),
  triggeredTickId: text("triggered_tick_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const accountFleetTicks = sqliteTable("account_fleet_ticks", {
  id: text("id").primaryKey(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at").notNull(),
  durationMs: integer("duration_ms").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  skippedReason: text("skipped_reason").notNull(),
  errorMessage: text("error_message"),
  plannedTotal: integer("planned_total").notNull().default(0),
  appliedTotal: integer("applied_total").notNull().default(0),
  observedJson: text("observed_json").notNull(),
  plannedActionsJson: text("planned_actions_json").notNull(),
  appliedActionsJson: text("applied_actions_json").notNull(),
  triggeredJobIdsJson: text("triggered_job_ids_json").notNull().default("[]")
});

export const accountBudgets = sqliteTable("account_budgets", {
  windowKey: text("window_key").primaryKey(),
  registrationsUsed: integer("registrations_used").notNull().default(0),
  registrationsBudget: integer("registrations_budget").notNull(),
  smsCostCents: integer("sms_cost_cents").notNull().default(0),
  resetAt: text("reset_at").notNull(),
  updatedAt: text("updated_at").notNull()
});
