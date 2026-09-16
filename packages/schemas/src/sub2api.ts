import { z } from "zod";

export const SUB2API_PROXY_NAME_MAX_BYTES = 100;

export const sub2ApiProxySchema = z.object({
  proxy_key: z.string().min(1),
  name: z.string().min(1).refine(
    (value) => new TextEncoder().encode(value).length <= SUB2API_PROXY_NAME_MAX_BYTES,
    "Sub2API proxy name exceeds the UTF-8 byte limit"
  ),
  protocol: z.literal("socks5"),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().optional(),
  password: z.string().optional(),
  status: z.enum(["active", "inactive"])
});

export type Sub2ApiProxy = z.infer<typeof sub2ApiProxySchema>;

export const sub2ApiExportSchema = z.object({
  proxies: z.array(sub2ApiProxySchema),
  accounts: z.array(z.unknown()).default([])
});

export type Sub2ApiExport = z.infer<typeof sub2ApiExportSchema>;

export const sub2ApiExportRequestSchema = z.object({
  selectedHashes: z.array(z.string().min(8)).default([]),
  host: z.string().min(1).optional(),
  filename: z.string().min(1).default("sub2api-proxies.json"),
  failedNodeStatus: z.enum(["active", "inactive"]).default("inactive")
});

export type Sub2ApiExportRequest = z.infer<typeof sub2ApiExportRequestSchema>;

export const sub2ApiExcludedNodeSchema = z.object({
  hash: z.string().min(8),
  name: z.string().min(1),
  reason: z.enum(["not_selected", "not_active", "missing_port"])
});

export type Sub2ApiExcludedNode = z.infer<typeof sub2ApiExcludedNodeSchema>;

export const sub2ApiExportPreviewSchema = z.object({
  export: sub2ApiExportSchema,
  selected: z.number().int().nonnegative(),
  exportable: z.number().int().nonnegative(),
  excluded: z.array(sub2ApiExcludedNodeSchema),
  summary: z.object({
    notSelected: z.number().int().nonnegative(),
    notActive: z.number().int().nonnegative(),
    missingPort: z.number().int().nonnegative()
  })
});

export type Sub2ApiExportPreview = z.infer<typeof sub2ApiExportPreviewSchema>;

export const sub2ApiConnectionConfigSchema = z.object({
  baseUrl: z.string().url(),
  adminApiKey: z.string().min(1),
  timezone: z.string().min(1).default("Asia/Shanghai"),
  managedProxyPrefix: z.string().min(1).default("MH-")
});

export type Sub2ApiConnectionConfig = z.infer<typeof sub2ApiConnectionConfigSchema>;

export const sub2ApiSafeConnectionConfigSchema = z.object({
  configured: z.boolean(),
  baseUrl: z.string().url().optional(),
  timezone: z.string().min(1).optional(),
  managedProxyPrefix: z.string().min(1).optional(),
  apiKeyConfigured: z.boolean()
});

export type Sub2ApiSafeConnectionConfig = z.infer<typeof sub2ApiSafeConnectionConfigSchema>;

export const sub2ApiProxyRecordSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  protocol: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().optional().nullable(),
  password: z.string().optional().nullable(),
  status: z.string().min(1),
  account_count: z.number().int().nonnegative().optional(),
  country: z.string().optional().nullable(),
  country_code: z.string().optional().nullable(),
  region: z.string().optional().nullable(),
  city: z.string().optional().nullable()
});

export type Sub2ApiProxyRecord = z.infer<typeof sub2ApiProxyRecordSchema>;

/** Sub2API account 真实结构里的 credentials 块（GET /admin/accounts 不返回原文 token，
 *  只返回 email / client_id / organization_id 等标识性字段）。 */
export const sub2ApiAccountCredentialsViewSchema = z
  .object({
    email: z.string().optional().nullable(),
    client_id: z.string().optional().nullable(),
    organization_id: z.string().optional().nullable(),
    expires_at: z.union([z.number(), z.string()]).optional().nullable()
  })
  .passthrough();

/** credentials_status 三个布尔信号 —— 区分账号"理论上有 token" 还是"没 token"。 */
export const sub2ApiAccountCredentialsStatusSchema = z
  .object({
    has_access_token: z.boolean().optional(),
    has_id_token: z.boolean().optional(),
    has_refresh_token: z.boolean().optional()
  })
  .passthrough();

/** extra 块的 codex 配额字段。Hive sense 用 codex_7d_used_percent 判定 quota_exhausted。 */
export const sub2ApiAccountExtraSchema = z
  .object({
    email: z.string().optional().nullable(),
    codex_5h_used_percent: z.number().optional().nullable(),
    codex_7d_used_percent: z.number().optional().nullable(),
    codex_primary_used_percent: z.number().optional().nullable(),
    codex_usage_updated_at: z.string().optional().nullable(),
    privacy_mode: z.string().optional().nullable()
  })
  .passthrough();

export const sub2ApiAccountRecordSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  platform: z.string().optional().nullable(),
  type: z.string().optional().nullable(),
  status: z.string().optional().nullable(),
  group_ids: z.array(z.number().int()).optional(),
  proxy_id: z.number().int().positive().optional().nullable(),
  proxy: sub2ApiProxyRecordSchema.partial().optional().nullable(),
  /** 顶层 email 在抓包里不存在；这里保留兼容字段，真实值在 credentials.email */
  email: z.string().optional().nullable(),
  credentials: sub2ApiAccountCredentialsViewSchema.optional().nullable(),
  credentials_status: sub2ApiAccountCredentialsStatusSchema.optional().nullable(),
  extra: sub2ApiAccountExtraSchema.optional().nullable(),
  /** 调度信号字段（抓包 §"获取账号列表" 中的实际命名）*/
  schedulable: z.boolean().optional(),
  last_used_at: z.string().optional().nullable(),
  rate_limited_at: z.string().optional().nullable(),
  rate_limit_reset_at: z.string().optional().nullable(),
  temp_unschedulable_until: z.string().optional().nullable(),
  temp_unschedulable_reason: z.string().optional().nullable(),
  error_message: z.string().optional().nullable()
});

export type Sub2ApiAccountRecord = z.infer<typeof sub2ApiAccountRecordSchema>;

export const sub2ApiAccountFiltersSchema = z.object({
  platform: z.string().default("openai"),
  type: z.string().default(""),
  status: z.string().default("active"),
  privacyMode: z.string().default(""),
  group: z.string().default(""),
  search: z.string().default("")
});

export type Sub2ApiAccountFilters = z.infer<typeof sub2ApiAccountFiltersSchema>;

export const sub2ApiProtectedProxyRuleSchema = z.object({
  proxyIds: z.array(z.number().int().positive()).default([]),
  nameIncludes: z.string().default(""),
  hostIncludes: z.string().default(""),
  port: z.number().int().min(1).max(65535).optional(),
  countryIncludes: z.string().default(""),
  regionIncludes: z.string().default(""),
  status: z.string().default("")
});

export type Sub2ApiProtectedProxyRule = z.infer<typeof sub2ApiProtectedProxyRuleSchema>;

export const sub2ApiAssignmentOptionsSchema = z.object({
  filters: sub2ApiAccountFiltersSchema.default({}),
  protectedRule: sub2ApiProtectedProxyRuleSchema.default({}),
  overwriteExisting: z.boolean().default(false)
});

export type Sub2ApiAssignmentOptions = z.infer<typeof sub2ApiAssignmentOptionsSchema>;

export const sub2ApiAssignmentChangeSchema = z.object({
  accountId: z.number().int().positive(),
  accountName: z.string().min(1),
  oldProxyId: z.number().int().positive().nullable(),
  oldProxyName: z.string().nullable(),
  newProxyId: z.number().int().positive(),
  newProxyName: z.string().min(1),
  reason: z.enum(["missing_proxy", "invalid_proxy", "overwrite"])
});

export type Sub2ApiAssignmentChange = z.infer<typeof sub2ApiAssignmentChangeSchema>;

export const sub2ApiAssignmentPreviewSchema = z.object({
  options: sub2ApiAssignmentOptionsSchema,
  summary: z.object({
    accounts: z.number().int().nonnegative(),
    proxies: z.number().int().nonnegative(),
    protectedProxies: z.number().int().nonnegative(),
    assignableProxies: z.number().int().nonnegative(),
    protectedAccounts: z.number().int().nonnegative(),
    unchangedAccounts: z.number().int().nonnegative(),
    changedAccounts: z.number().int().nonnegative(),
    batches: z.number().int().nonnegative()
  }),
  protectedProxies: z.array(sub2ApiProxyRecordSchema),
  assignableProxies: z.array(sub2ApiProxyRecordSchema),
  protectedAccounts: z.array(sub2ApiAccountRecordSchema),
  unchangedAccounts: z.array(sub2ApiAccountRecordSchema),
  changes: z.array(sub2ApiAssignmentChangeSchema),
  errors: z.array(z.string())
});

export type Sub2ApiAssignmentPreview = z.infer<typeof sub2ApiAssignmentPreviewSchema>;

export const sub2ApiAssignmentApplyResultSchema = z.object({
  preview: sub2ApiAssignmentPreviewSchema,
  success: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  successIds: z.array(z.number().int().positive()),
  failedIds: z.array(z.number().int().positive()),
  results: z.array(
    z.object({
      accountId: z.number().int().positive(),
      proxyId: z.number().int().positive(),
      success: z.boolean(),
      message: z.string().optional()
    })
  )
});

export type Sub2ApiAssignmentApplyResult = z.infer<typeof sub2ApiAssignmentApplyResultSchema>;

export const sub2ApiSyncSummarySchema = z.object({
  proxies: z.number().int().nonnegative(),
  accounts: z.number().int().nonnegative(),
  matchedLocalNodes: z.number().int().nonnegative(),
  protectedProxies: z.number().int().nonnegative()
});

export type Sub2ApiSyncSummary = z.infer<typeof sub2ApiSyncSummarySchema>;

export const sub2ApiReconcilePlanSchema = sub2ApiAssignmentPreviewSchema.extend({
  mode: z.enum(["steady_balance", "drain_nodes", "enable_nodes"]).default("steady_balance"),
  affectedNodeHashes: z.array(z.string().min(8)).default([]),
  risks: z.array(z.string()).default([])
});

export type Sub2ApiReconcilePlan = z.infer<typeof sub2ApiReconcilePlanSchema>;

export const sub2ApiReconcileApplyResultSchema = sub2ApiAssignmentApplyResultSchema.extend({
  operationId: z.string().min(1)
});

export type Sub2ApiReconcileApplyResult = z.infer<typeof sub2ApiReconcileApplyResultSchema>;

export const sub2ApiMaintenancePreviewSchema = z.object({
  managedProxyPrefix: z.string().min(1),
  summary: z.object({
    proxies: z.number().int().nonnegative(),
    managedProxies: z.number().int().nonnegative(),
    managedAccounts: z.number().int().nonnegative(),
    emptyManagedProxies: z.number().int().nonnegative(),
    drainChanges: z.number().int().nonnegative(),
    protectedAccounts: z.number().int().nonnegative(),
    assignableTargets: z.number().int().nonnegative()
  }),
  managedProxies: z.array(sub2ApiProxyRecordSchema),
  emptyManagedProxies: z.array(sub2ApiProxyRecordSchema),
  drainPlan: sub2ApiAssignmentPreviewSchema,
  risks: z.array(z.string()).default([])
});

export type Sub2ApiMaintenancePreview = z.infer<typeof sub2ApiMaintenancePreviewSchema>;

export const sub2ApiMaintenanceApplyResultSchema = z.object({
  preview: sub2ApiMaintenancePreviewSchema,
  reassigned: z.number().int().nonnegative(),
  failedReassign: z.number().int().nonnegative(),
  deletedProxies: z.number().int().nonnegative(),
  failedDeleteProxies: z.array(
    z.object({
      proxyId: z.number().int().positive(),
      name: z.string().min(1),
      message: z.string().min(1)
    })
  )
});

export type Sub2ApiMaintenanceApplyResult = z.infer<typeof sub2ApiMaintenanceApplyResultSchema>;

export const sub2ApiImportErrorSchema = z.object({
  kind: z.string(),
  name: z.string().optional(),
  proxy_key: z.string().optional(),
  message: z.string()
});

export type Sub2ApiImportError = z.infer<typeof sub2ApiImportErrorSchema>;

export const sub2ApiImportProxyDataResultSchema = z.object({
  proxy_created: z.number().int().nonnegative().default(0),
  proxy_reused: z.number().int().nonnegative().default(0),
  proxy_failed: z.number().int().nonnegative().default(0),
  account_created: z.number().int().nonnegative().default(0),
  account_failed: z.number().int().nonnegative().default(0),
  errors: z.array(sub2ApiImportErrorSchema).default([])
});

export type Sub2ApiImportProxyDataResult = z.infer<typeof sub2ApiImportProxyDataResultSchema>;

export const sub2ApiProxyQualityCheckItemSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    status: z.string().optional(),
    message: z.string().optional(),
    latency_ms: z.number().optional().nullable()
  })
  .passthrough();

export type Sub2ApiProxyQualityCheckItem = z.infer<typeof sub2ApiProxyQualityCheckItemSchema>;

export const sub2ApiProxyQualityResultSchema = z.object({
  proxy_id: z.number().int().positive(),
  score: z.number().int().min(0).max(100).optional(),
  grade: z.string().optional(),
  summary: z.string().optional(),
  exit_ip: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
  country_code: z.string().optional().nullable(),
  base_latency_ms: z.number().optional().nullable(),
  passed_count: z.number().int().nonnegative().default(0),
  warn_count: z.number().int().nonnegative().default(0),
  failed_count: z.number().int().nonnegative().default(0),
  challenge_count: z.number().int().nonnegative().default(0),
  checked_at: z.number().optional().nullable(),
  items: z.array(sub2ApiProxyQualityCheckItemSchema).default([])
});

export type Sub2ApiProxyQualityResult = z.infer<typeof sub2ApiProxyQualityResultSchema>;

export const sub2ApiUpstreamErrorSchema = z
  .object({
    account_id: z.number().int().positive().optional().nullable(),
    account_name: z.string().optional().nullable(),
    platform: z.string().optional().nullable(),
    model: z.string().optional().nullable(),
    status_code: z.number().int().optional().nullable(),
    message: z.string().optional().nullable(),
    phase: z.string().optional().nullable(),
    type: z.string().optional().nullable(),
    severity: z.string().optional().nullable(),
    created_at: z.union([z.string(), z.number()]).optional().nullable(),
    upstream_endpoint: z.string().optional().nullable(),
    requested_model: z.string().optional().nullable()
  })
  .passthrough();

export type Sub2ApiUpstreamError = z.infer<typeof sub2ApiUpstreamErrorSchema>;

export const sub2ApiUpstreamErrorListOptionsSchema = z.object({
  timeRange: z.string().default("1h"),
  view: z.string().default("errors"),
  phase: z.string().default("upstream")
});

export type Sub2ApiUpstreamErrorListOptions = z.infer<typeof sub2ApiUpstreamErrorListOptionsSchema>;

// ─── Account write APIs (notes/account-fleet-design.md §11.4) ──────

/** POST /admin/openai/refresh-token：用 refresh_token 换出完整 token bundle。
 *  注意：Sub2API 内部已经做 token refresh；如果该 refresh_token 在 Sub2API 端已失效，
 *  这里也会失败。该端点的"导入新账号"用法是给 codex-tool login/all 刚拿到的 fresh
 *  refresh_token 落地 Sub2API。 */
export const sub2ApiRefreshOpenaiTokenResultSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().min(1),
  expires_in: z.number().int().optional(),
  expires_at: z.number().int(),
  client_id: z.string().min(1),
  email: z.string().min(1),
  organization_id: z.string().min(1)
});
export type Sub2ApiRefreshOpenaiTokenResult = z.infer<typeof sub2ApiRefreshOpenaiTokenResultSchema>;

/** POST /admin/accounts —— 创建账号 */
export const sub2ApiCreateAccountCredentialsSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().min(1),
  expires_at: z.number().int(),
  client_id: z.string().min(1),
  email: z.string().min(1),
  organization_id: z.string().min(1),
  model_mapping: z.record(z.string()).default({})
});
export type Sub2ApiCreateAccountCredentials = z.infer<typeof sub2ApiCreateAccountCredentialsSchema>;

export const sub2ApiCreateAccountPayloadSchema = z.object({
  name: z.string().min(1),
  notes: z.string().default(""),
  platform: z.string().default("openai"),
  type: z.string().default("oauth"),
  credentials: sub2ApiCreateAccountCredentialsSchema,
  extra: z.record(z.unknown()).default({}),
  proxy_id: z.number().int().positive(),
  concurrency: z.number().int().min(1).default(10),
  priority: z.number().int().default(1),
  rate_multiplier: z.number().default(1),
  group_ids: z.array(z.number().int().positive()).default([]),
  expires_at: z.union([z.number(), z.null()]).default(null),
  auto_pause_on_expired: z.boolean().default(true)
});
export type Sub2ApiCreateAccountPayload = z.infer<typeof sub2ApiCreateAccountPayloadSchema>;

/** 创建后返回的精简记录（API 返回的完整对象走 sub2ApiAccountRecordSchema）。
 *  我们只关心 id + email + status 这些"立即可写回本地"的字段。 */
export const sub2ApiCreateAccountResultSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1),
    platform: z.string().optional().nullable(),
    type: z.string().optional().nullable(),
    status: z.string().optional().nullable(),
    proxy_id: z.number().int().positive().optional().nullable(),
    email: z.string().optional().nullable()
  })
  .passthrough();
export type Sub2ApiCreateAccountResult = z.infer<typeof sub2ApiCreateAccountResultSchema>;

/** GET /admin/accounts/{id}/usage —— 5h + 7d 配额窗口 */
export const sub2ApiAccountUsageWindowSchema = z.object({
  utilization: z.number().default(0),
  resets_at: z.union([z.string(), z.number(), z.null()]).optional(),
  remaining_seconds: z.number().int().default(0),
  window_stats: z
    .object({
      requests: z.number().int().nonnegative().default(0),
      tokens: z.number().int().nonnegative().default(0),
      cost: z.number().default(0),
      standard_cost: z.number().default(0),
      user_cost: z.number().default(0)
    })
    .default({})
});
export type Sub2ApiAccountUsageWindow = z.infer<typeof sub2ApiAccountUsageWindowSchema>;

export const sub2ApiAccountUsageResultSchema = z.object({
  updated_at: z.string().optional(),
  five_hour: sub2ApiAccountUsageWindowSchema.default({}),
  seven_day: sub2ApiAccountUsageWindowSchema.default({})
});
export type Sub2ApiAccountUsageResult = z.infer<typeof sub2ApiAccountUsageResultSchema>;

/** PUT /admin/accounts/{id}/schedulable —— body: { schedulable: boolean }
 *  返回包含被更新账号的完整记录；我们这里宽松解析，只取关键字段。 */
export const sub2ApiSchedulableToggleResultSchema = z
  .object({
    id: z.number().int().positive(),
    schedulable: z.boolean(),
    status: z.string().optional().nullable()
  })
  .passthrough();
export type Sub2ApiSchedulableToggleResult = z.infer<typeof sub2ApiSchedulableToggleResultSchema>;

/** GET /admin/groups */
export const sub2ApiGroupRecordSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1),
    platform: z.string().min(1),
    status: z.string().optional(),
    sort_order: z.number().int().optional(),
    description: z.string().optional().nullable(),
    account_count: z.number().int().nonnegative().optional(),
    active_account_count: z.number().int().nonnegative().optional(),
    rate_limited_account_count: z.number().int().nonnegative().optional()
  })
  .passthrough();
export type Sub2ApiGroupRecord = z.infer<typeof sub2ApiGroupRecordSchema>;
