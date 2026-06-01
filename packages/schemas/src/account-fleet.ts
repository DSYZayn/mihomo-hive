import { z } from "zod";

/**
 * Account Fleet schemas —— 账号生命周期编排器的所有类型。
 * 设计文档：notes/account-fleet-design.md
 *
 * 三维状态（origin × intent × health）的语义：
 * - origin   = 账号来源 / 信任度，决定自动化等级
 * - intent   = 系统当前打算做什么
 * - health   = 最近一次观察的真实状态
 */

// ─── 三维状态 ───────────────────────────────────

export const accountOriginSchema = z.enum([
  "hive_registered",      // Hive 用 codex-tool 注册的，凭据全在
  "adopted_active",       // 接管自 Sub2API + 当前健康，凭据只在 Sub2API 端
  "adopted_recovered",    // 接管后通过 codex_login 救回，Hive 已掌握 phone+pwd+token
  "adopted_observing",    // 接管但缺凭据 / 当前 broken，等用户决策
  "retired_legacy"        // 用户主动弃用
]);
export type AccountOrigin = z.infer<typeof accountOriginSchema>;

export const accountIntentSchema = z.enum([
  "pending",        // 本地登记完成、Sub2API 端尚未存在（register/login job 排队中）
  "active",         // Sub2API 有对应记录，scheduler 视为正常
  "recovering",     // 当前 broken，有 job 在跑修复
  "retired"         // 已退役
]);
export type AccountIntent = z.infer<typeof accountIntentSchema>;

export const accountHealthSchema = z.enum([
  "healthy",            // has_refresh_token=true + usage 正常 + 无 upstream-errors
  "rate_limited",       // rate_limited_at 非空 + rate_limit_reset_at 未到
  "quota_exhausted",    // extra.codex_7d_used_percent ≥ 阈值
  "broken",             // has_refresh_token=false 或错误率破预算
  "unknown"             // 新接管未观察
]);
export type AccountHealth = z.infer<typeof accountHealthSchema>;

export const accountRecoveryPathSchema = z.enum(["codex_login", "codex_register"]);
export type AccountRecoveryPath = z.infer<typeof accountRecoveryPathSchema>;

// ─── 账号变更历史 ────────────────────────────────────

/**
 * 账号变更历史的单条记录。最近 N 条以环形缓冲存在 accounts.change_history（JSON），
 * head（数组首位）为最新。捕捉账号真实状态/额度变动，供"最近有变动"筛选 + 排序 + 运维审计：
 *   - health：健康档位翻转（healthy↔broken↔quota_exhausted↔rate_limited↔unknown）
 *   - intent：意图翻转（active↔recovering↔retired↔pending）
 *   - quota：Sub2API 同步来的额度变动；连续的额度变动会"合并"成一条
 *            （from 保留这一段开始时的值、to 持续更新到最新），避免刷屏，
 *            从而能看出"这账号从 X% 被用到了 Y%"。
 *
 * 设计要点：head 的 at 即"最近一次变动时间"，所以不需要单独的 healthChangedAt 列。
 */
export const accountChangeEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("health"),
    at: z.string(),
    from: accountHealthSchema,
    to: accountHealthSchema
  }),
  z.object({
    kind: z.literal("intent"),
    at: z.string(),
    from: accountIntentSchema,
    to: accountIntentSchema
  }),
  z.object({
    kind: z.literal("quota"),
    at: z.string(),
    q5From: z.number().int().min(0).max(100).nullable(),
    q5To: z.number().int().min(0).max(100).nullable(),
    q7From: z.number().int().min(0).max(100).nullable(),
    q7To: z.number().int().min(0).max(100).nullable()
  })
]);
export type AccountChangeEntry = z.infer<typeof accountChangeEntrySchema>;

// ─── 账号记录 ────────────────────────────────────

// 持久化层（含 enc_* 字段）——只在 server 内部使用，不出 API
export const accountRecordInternalSchema = z.object({
  id: z.string().min(1),
  externalId: z.number().int().positive().nullable(),
  origin: accountOriginSchema,
  intent: accountIntentSchema,
  health: accountHealthSchema,

  email: z.string().min(1),
  organizationId: z.string().nullable(),
  clientId: z.string().nullable(),
  platform: z.string().min(1).default("openai"),
  type: z.string().min(1).default("oauth"),

  // 加密字段
  encPhone: z.string().nullable(),
  encPassword: z.string().nullable(),
  encRefreshToken: z.string().nullable(),
  encAccessToken: z.string().nullable(),
  encIdToken: z.string().nullable(),
  encRecoveryInputJson: z.string().nullable(),

  // 观察快照
  lastObservedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  rateLimitedAt: z.string().nullable(),
  rateLimitResetAt: z.string().nullable(),
  quota5hPercent: z.number().int().min(0).max(100).nullable(),
  quota7dPercent: z.number().int().min(0).max(100).nullable(),
  errorsInWindow: z.number().int().nonnegative().default(0),
  brokenSinceTick: z.string().nullable(),
  brokenConsecutiveTicks: z.number().int().nonnegative().default(0),

  // 修复跟踪
  recoveryAttempts: z.number().int().nonnegative().default(0),
  nextRecoveryAfter: z.string().nullable(),
  lastRecoveryError: z.string().nullable(),
  lastRecoveryPath: accountRecoveryPathSchema.nullable(),
  /**
   * codex-tool 上次返回的 OAuth 失败分类（external-integration.md §"OAuth 失败分类"）。
   *   - account_unusable → 永久不可用，worker 不再重试
   *   - network_or_proxy → 代理/网络类失败，延后再试
   *   - oauth_failed     → 普通 OAuth 失败
   * 为 null 表示无最近失败 / 老版本 codex-tool 没返回该字段。
   */
  lastRecoveryFailureCategory: z
    .enum(["account_unusable", "network_or_proxy", "oauth_failed"])
    .nullable(),

  /** 是否接受自动化运维任务分配（恢复/重绑等）。false=暂停该账号一切自动化，用于隔离实验
   * （把现有账号全停、只让新账号跑实验，避免死号干扰）。 */
  opsEnabled: z.boolean().default(true),
  /** 注册时 hero-sms 的激活 ID（getNumber 返回 ACCESS_NUMBER:<id>:<号>）。登录被要求手机
   * OTP(step-up) 时用它对原号"重新激活"二次接码。null=未知/老账号。 */
  herosmsActivationId: z.string().nullable().default(null),

  // 溯源
  batchId: z.string().nullable(),
  registeredAt: z.string().nullable(),

  /**
   * codex-tool 注册时实际使用的国家码（external-integration.md §"成本上限和选区策略"
   * 的 sms_country）。仅供观测 / 审计用：发现某国号码批量风控时反查"哪些账号是这个
   * 国家来的"。注册失败 / adopted 路径下为 null。
   */
  smsCountry: z.string().nullable(),
  /**
   * 注册时短信成本（USD * 100，按整数 cent 存）。仅供观测；汇总成本走
   * account_budgets.sms_cost_cents（窗口化）。
   */
  smsCostCents: z.number().int().nonnegative().nullable(),

  /**
   * 软粘性的代理出口偏好 —— 账号首次注册 / 上次登录用过的本地节点 hash。
   *
   * 不是强绑定：节点失效或质量下降时会 fallback 到加权选择。设计目标：
   *   - 减少同账号在不同节点之间漂移
   *   - 分散新账号到不同节点（避免"永远在同一个 IP 注册"被风控）
   *
   * 由 worker 的 codex_login / codex_register / import_to_sub2api 在选好节点
   * 后回写，不参与 reconcile 的 proxy_id 绑定（那是代理编排的领地）。
   */
  egressNodeHash: z.string().nullable(),

  /**
   * 账号质量指标（P5-AQ）：
   *   firstSeenAt     —— 首次进入系统的时间。优先级：codex-tool 导出的 created_at >
   *                      hive 注册时间 > 接管时间。用来算"存活天数"。
   *   reloginCount    —— 累计 codex_login 修复成功次数（不随成功重置，单调递增）。
   *                      跟 recoveryAttempts（当前连续尝试，成功即清零）区别开。
   *   lastRecoveredAt —— 最近一次修复成功时间。
   * 三者结合 health / quota 帮用户判断账号质量（存活越久、重登越少越稳）。
   */
  firstSeenAt: z.string().nullable(),
  reloginCount: z.number().int().nonnegative().default(0),
  lastRecoveredAt: z.string().nullable(),

  /**
   * 最近 N 条变更历史（环形缓冲，head 最新），由持久化层在写入时 diff 旧值自动维护。
   * 见 accountChangeEntrySchema。新建记录可省略（视为空），从 DB 读出时总是有值。
   */
  changeHistory: z.array(accountChangeEntrySchema).optional(),

  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

export type AccountRecordInternal = z.infer<typeof accountRecordInternalSchema>;

// 对外暴露的脱敏视图（API / UI）——不含 enc_*，凭据只暴露布尔标记
export const accountRecordViewSchema = z.object({
  id: z.string().min(1),
  externalId: z.number().int().positive().nullable(),
  origin: accountOriginSchema,
  intent: accountIntentSchema,
  health: accountHealthSchema,

  email: z.string().min(1),
  organizationId: z.string().nullable(),
  platform: z.string().min(1),

  hasPhonePassword: z.boolean(),
  hasRefreshToken: z.boolean(),

  lastObservedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  rateLimitedAt: z.string().nullable(),
  rateLimitResetAt: z.string().nullable(),
  quota5hPercent: z.number().int().min(0).max(100).nullable(),
  quota7dPercent: z.number().int().min(0).max(100).nullable(),
  errorsInWindow: z.number().int().nonnegative().default(0),
  /** 首次进入当前掉线档的时间戳（掉线时打戳、恢复时清空）。用于把存活时间冻结在掉线那一刻。 */
  brokenSinceTick: z.string().nullable(),

  recoveryAttempts: z.number().int().nonnegative().default(0),
  nextRecoveryAfter: z.string().nullable(),
  lastRecoveryError: z.string().nullable(),
  lastRecoveryPath: accountRecoveryPathSchema.nullable(),
  lastRecoveryFailureCategory: z
    .enum(["account_unusable", "network_or_proxy", "oauth_failed"])
    .nullable(),
  /** 是否接受自动化运维(false=已暂停,不分配任何自动任务)。 */
  opsEnabled: z.boolean().default(true),
  /** hero-sms 激活 ID（登录 step-up 二次接码用）。 */
  herosmsActivationId: z.string().nullable().default(null),

  batchId: z.string().nullable(),
  registeredAt: z.string().nullable(),
  smsCountry: z.string().nullable(),
  smsCostCents: z.number().int().nonnegative().nullable(),
  egressNodeHash: z.string().nullable(),

  // P5-AQ 账号质量
  firstSeenAt: z.string().nullable(),
  reloginCount: z.number().int().nonnegative().default(0),
  lastRecoveredAt: z.string().nullable(),

  /**
   * 当前代理编排把这账号绑到了哪个本地节点 —— 通过 Sub2API account.proxy_id
   * → 本地 nodes.sub2apiProxyId 反查得到。
   *
   * 与 egressNodeHash 的区别：
   *   • egressNodeHash 是"上次 codex-tool 出口走的节点"（注册 / 登录时写入），
   *     adopted_* 路径不会有
   *   • currentNodeHash / Name 是"远端 Sub2API 此刻把这账号挂在哪个代理上"，
   *     由代理编排 reconcile 同步过去
   *
   * 仅在 status snapshot 时 server 端关联 Sub2API + 本地节点表填充。
   * 如果 Sub2API 未连接 / 账号没绑代理 / 节点不在本地，则为 null。
   */
  currentProxyId: z.number().int().positive().nullable().optional(),
  currentNodeHash: z.string().nullable().optional(),
  currentNodeName: z.string().nullable().optional(),

  /**
   * P5-AU: Sub2API 侧"限流中"冷却信号（status 查询时从 live Sub2API 实时读取，不持久化）。
   *   tempUnschedulableUntil —— Sub2API 发现配额耗尽后给账号设的冷却截止时间，到点才会
   *     重新参与调度。结合 rateLimitResetAt(配额重置预计时间) 让用户知道账号何时自然恢复，
   *     避免在冷却期内瞎触发恢复。
   */
  tempUnschedulableUntil: z.string().nullable().optional(),
  tempUnschedulableReason: z.string().nullable().optional(),

  /** 最近 N 条变更历史（health/intent/额度），head 最新。供"最近有变动"筛选/排序与运维审计。 */
  changeHistory: z.array(accountChangeEntrySchema).default([]),

  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

export type AccountRecordView = z.infer<typeof accountRecordViewSchema>;

/**
 * 短信地区经验回灌（external-integration.md §"成本上限和选区策略"）—— Hive 完全
 * 透明保存：codex-tool 注册返回的 sms_region_result blob 原样存到 settings.value_json，
 * 下次注册前作为 phone_sms.region_hint 原样回传。
 *
 * 不解析具体字段含义（country / operator / TTL / 失败计数都是 codex-tool 内部约定）。
 * 仅 UI 上展示 blob 内容方便用户观测"上次注册成功用的哪国号码、什么时候"。
 *
 * 配套字段 lastUpdatedAt 由 Hive 写入，让 UI 显示"经验新鲜度"。
 */
export const smsRegionHintMemorySchema = z.object({
  hint: z.unknown().nullable(),
  lastUpdatedAt: z.string().nullable()
});
export type SmsRegionHintMemory = z.infer<typeof smsRegionHintMemorySchema>;

// ─── Spec（用户配置）─────────────────────────────

export const accountFleetTargetPolicySchema = z.object({
  healthyAccountsTarget: z.number().int().nonnegative().default(50),
  targetGroupId: z.number().int().positive().default(2),
  minHealthyRatio: z.number().min(0).max(1).default(0.8),
  /**
   * P5-AW 均衡度（0-100）：补充健康账号时更倾向"重登旧账号"还是"注册新账号"。
   *   0   = 完全靠重登旧的掉线账号(codex_login)，本 tick 不主动注册新号；
   *   100 = 健康缺口尽量用注册新号补满(codex_register)；
   *   中间值 = 缺口按比例只注册一部分，其余留给重登恢复。
   * 仅影响"注册新号补缺口"的数量（recover_via_login 对掉线账号始终照常尝试）。
   * registration.enabled=false 时此项无效（根本不注册）。
   */
  registerBias: z.number().int().min(0).max(100).default(40),
  naming: z
    .object({
      template: z.string().min(1).default("Hive-{date}-{seq}"),
      notes: z.string().default("")
    })
    .default({})
});

export type AccountFleetTargetPolicy = z.infer<typeof accountFleetTargetPolicySchema>;

export const accountFleetHealthPolicySchema = z.object({
  refreshTokenMissingAsUnhealthy: z.boolean().default(true),
  rateLimitedAsUnhealthy: z.boolean().default(false),
  quotaExhaustedThresholdPercent: z.number().int().min(0).max(100).default(95),
  usagePollIntervalMs: z.number().int().min(60_000).default(30 * 60_000),
  errorBudgetPerWindow: z.number().int().min(1).default(5),
  windowMs: z.number().int().min(60_000).default(5 * 60_000),
  adoptedDemotionConsecutiveTicks: z.number().int().min(1).default(3)
});

export type AccountFleetHealthPolicy = z.infer<typeof accountFleetHealthPolicySchema>;

export const accountFleetRecoveryPolicySchema = z.object({
  enabled: z.boolean().default(false),
  pathPriority: z.array(accountRecoveryPathSchema).min(1).default(["codex_login", "codex_register"]),
  maxConcurrent: z.number().int().min(1).max(10).default(2),
  backoffSequenceMs: z
    .array(z.number().int().min(1000))
    .min(1)
    .default([60_000, 5 * 60_000, 30 * 60_000, 6 * 3_600_000]),
  maxAttemptsPerAccount: z.number().int().min(1).default(5),
  perTickRecoveryCap: z.number().int().min(0).default(10),
  deleteOldAccountOnRecovery: z.boolean().default(true)
});

export type AccountFleetRecoveryPolicy = z.infer<typeof accountFleetRecoveryPolicySchema>;

export const accountFleetRegistrationPolicySchema = z.object({
  enabled: z.boolean().default(false),
  perTickCap: z.number().int().min(0).default(5),
  dailyBudget: z.number().int().min(0).default(50),
  monthlyBudget: z.number().int().min(0).default(1000),
  /**
   * 单账号注册成本上限（USD）—— 必须存在才允许触发注册，避免成本失控。
   * 默认 0.05，codex-tool 侧据此自行选择最便宜的可用接码地区，Hive 不再硬编码地区。
   *
   * codex-tool 接入约定：config JSON 中 `phone_sms.max_cost_per_account_usd` 字段，
   * codex-tool 内部按价格升序遍历地区，跳过超过此上限的，跳过库存为 0 的；
   * 如果没有任何符合的地区 → 返回 registration_failed 而不是花更高价格强抢。
   * 详细需求见 notes/codex-tool-needs.md。
   */
  maxCostPerAccountUsd: z.number().min(0).default(0.05),
  autoAssignGroupIds: z.array(z.number().int().positive()).default([2]),
  emergencyMode: z
    .object({
      enabled: z.boolean().default(false),
      perTickCap: z.number().int().min(0).default(10),
      ignoreDailyBudget: z.boolean().default(false)
    })
    .default({})
});

export type AccountFleetRegistrationPolicy = z.infer<typeof accountFleetRegistrationPolicySchema>;

export const accountFleetRetirementPolicySchema = z.object({
  afterMaxFailedRecoveries: z.boolean().default(true),
  afterDeadDays: z.number().int().min(1).default(7),
  deleteOnRetire: z.boolean().default(false),
  drainBeforeDeleteMs: z.number().int().min(0).default(10 * 60_000)
});

export type AccountFleetRetirementPolicy = z.infer<typeof accountFleetRetirementPolicySchema>;

export const accountFleetCodexToolPolicySchema = z.object({
  binPath: z.string().default("codex-tool"),
  skymail: z
    .object({
      baseUrl: z.string().default(""),
      adminEmail: z.string().default(""),
      adminPasswordRef: z.string().default("")
    })
    .default({}),
  chatgpt: z
    .object({
      /** 旧的单一注册邮箱域名;仅当 mailDomains 没有任何启用项时作为回退。 */
      mailDomain: z.string().default(""),
      /**
       * 注册邮箱域名池:每次注册从"启用"的域名里随机抽一个,把风控指纹分散到多个
       * 自定义子域名上。enabled=false 可随时停用被风控的域名(实时生效,下个注册即不再抽到)。
       * 为空(或全部禁用)时回退到上面的单一 mailDomain。
       */
      mailDomains: z
        .array(
          z.object({
            domain: z.string().min(1),
            enabled: z.boolean().default(true)
          })
        )
        .default([]),
      chatWebClientId: z.string().default(""),
      codexClientId: z.string().default("")
    })
    .default({}),
  phoneSms: z
    .object({
      provider: z.enum(["herosms", "fivesim", "nexsms"]).default("herosms"),
      apiKeyRef: z.string().default(""),
      service: z.string().default("dr")
    })
    .default({}),
  httpUserAgentChrome: z
    .string()
    .default(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
    ),
  egress: z
    .object({
      mode: z.enum(["managed-node", "pinned-node", "none"]).default("managed-node"),
      pinnedNodeHash: z.string().nullable().default(null)
    })
    .default({}),
  timeouts: z
    .object({
      smsCountriesMs: z.number().int().min(1000).default(30_000),
      loginMs: z.number().int().min(1000).default(90_000),
      registerMs: z.number().int().min(1000).default(300_000)
    })
    .default({}),
  /**
   * 外置 Agent（推荐）：让 codex-tool 跑在桌面真实 OS（macOS/Win）上,Hive 经 HTTP 调用,
   * 而非在 Linux 容器里起浏览器（Linux headless 指纹会被 OpenAI 风控质询）。
   * enabled=false → 沿用本地 subprocess（向后兼容）。url 即"连接 host",云端部署改这里。
   */
  remoteAgent: z
    .object({
      enabled: z.boolean().default(false),
      url: z.string().default(""), // e.g. http://192.168.5.20:8765 ; 空=本地 subprocess
      tokenRef: z.string().default(""), // 共享 bearer token(密钥 ref,同 adminPasswordRef)
      healthCheck: z.boolean().default(true), // 调用前先 GET /health,不健康跳过本轮
      requestTimeoutPaddingMs: z.number().int().min(0).default(30_000) // HTTP 超时 = codex 超时 + 余量
    })
    .default({}),
  /**
   * 动态出口：开启后 Mihomo 额外渲染一个唯一鉴权口(hive-codex)+ codex-egress select 组,
   * Hive 选好节点后切该组 → 远程 codex-tool 经此口出去即走选定节点。对外只暴露一个鉴权端口,
   * 真实出口由 Hive 现有选节点逻辑分发到池中多个节点。host 是 agent 回连 Mihomo 的地址(预留可配)。
   */
  codexEgress: z
    .object({
      dynamic: z.boolean().default(false),
      host: z.string().default(""), // agent 看到的 Mihomo 地址(默认部署填 Hive LAN IP)
      port: z.number().int().min(1).max(65535).default(19000),
      bindHost: z.string().default("0.0.0.0") // 该唯一口的绑定(配具体 LAN IP + 防火墙更稳)
    })
    .default({})
});

export type AccountFleetCodexToolPolicy = z.infer<typeof accountFleetCodexToolPolicySchema>;

export const accountFleetSpecSchema = z.object({
  /**
   * 总开关。默认 false —— 系统启动后只观察（sense + diagnose 刷新账号视图），
   * 不计划任何修改。用户在 UI 显式打开后才会真触发 register / login / delete 等动作。
   */
  enabled: z.boolean().default(false),
  reconcileIntervalMs: z.number().int().min(30_000).default(5 * 60_000),
  graceBatchPercent: z.number().min(0).max(100).default(10),
  graceBatchAbs: z.number().int().min(0).default(50),

  /** 每个账号保留的变更历史条数上限（accounts.change_history 环形缓冲）。 */
  changeHistoryLimit: z.number().int().min(1).max(100).default(10),

  target: accountFleetTargetPolicySchema.default({}),
  health: accountFleetHealthPolicySchema.default({}),
  recovery: accountFleetRecoveryPolicySchema.default({}),
  registration: accountFleetRegistrationPolicySchema.default({}),
  retirement: accountFleetRetirementPolicySchema.default({}),
  codexTool: accountFleetCodexToolPolicySchema.default({})
});

export type AccountFleetSpec = z.infer<typeof accountFleetSpecSchema>;

export const defaultAccountFleetSpec: AccountFleetSpec = accountFleetSpecSchema.parse({});

// ─── Tick / Plan ─────────────────────────────────

export const accountFleetActionKindSchema = z.enum([
  "demote_to_observing",        // adopted_active → adopted_observing
  "recover_via_login",          // PATH_A
  "recover_via_register",       // PATH_B
  "register_new",               // 常规补充 / 紧急补给
  "retire",                     // 退役
  "delete_external",            // 从 Sub2API 删除
  "toggle_schedulable",         // 改 schedulable=false/true
  "observe_usage",              // /usage 轮询
  "defer"                       // 仍在退避窗口
]);
export type AccountFleetActionKind = z.infer<typeof accountFleetActionKindSchema>;

export const accountFleetPlannedActionSchema = z.object({
  kind: accountFleetActionKindSchema,
  accountId: z.string().nullable(),
  externalId: z.number().int().positive().nullable(),
  email: z.string().nullable(),
  reason: z.string().min(1)
});

export type AccountFleetPlannedAction = z.infer<typeof accountFleetPlannedActionSchema>;

export const accountFleetObservedSummarySchema = z.object({
  totalAccounts: z.number().int().nonnegative(),
  byHealth: z.object({
    healthy: z.number().int().nonnegative(),
    rate_limited: z.number().int().nonnegative(),
    quota_exhausted: z.number().int().nonnegative(),
    broken: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative()
  }),
  byOrigin: z.object({
    hive_registered: z.number().int().nonnegative(),
    adopted_active: z.number().int().nonnegative(),
    adopted_recovered: z.number().int().nonnegative(),
    adopted_observing: z.number().int().nonnegative(),
    retired_legacy: z.number().int().nonnegative()
  }),
  byIntent: z.object({
    pending: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    recovering: z.number().int().nonnegative(),
    retired: z.number().int().nonnegative()
  }),
  healthyCount: z.number().int().nonnegative(),
  target: z.number().int().nonnegative(),
  targetGap: z.number().int(),
  minHealthyRatio: z.number(),
  emergencyMode: z.boolean(),
  dailyRegistrationsUsed: z.number().int().nonnegative(),
  dailyRegistrationsBudget: z.number().int().nonnegative(),
  monthlyRegistrationsUsed: z.number().int().nonnegative(),
  monthlyRegistrationsBudget: z.number().int().nonnegative()
});

export type AccountFleetObservedSummary = z.infer<typeof accountFleetObservedSummarySchema>;

export const accountFleetTickSchema = z.object({
  id: z.string().min(1),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
  enabled: z.boolean(),
  skippedReason: z.enum([
    "applied",
    "no_change",
    "paused",
    "batch_capped",
    "budget_exhausted",
    "error"
  ]),
  errorMessage: z.string().optional(),
  plannedTotal: z.number().int().nonnegative(),
  appliedTotal: z.number().int().nonnegative(),
  observed: accountFleetObservedSummarySchema,
  plannedActions: z.array(accountFleetPlannedActionSchema),
  appliedActions: z.array(accountFleetPlannedActionSchema),
  triggeredJobIds: z.array(z.string().min(1)).default([])
});

export type AccountFleetTick = z.infer<typeof accountFleetTickSchema>;

export const accountFleetTickSummarySchema = z.object({
  id: z.string().min(1),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
  enabled: z.boolean(),
  plannedTotal: z.number().int().nonnegative(),
  appliedTotal: z.number().int().nonnegative(),
  skippedReason: accountFleetTickSchema.shape.skippedReason,
  errorMessage: z.string().optional()
});

export type AccountFleetTickSummary = z.infer<typeof accountFleetTickSummarySchema>;

// ─── Jobs ─────────────────────────────────────────

export const accountJobKindSchema = z.enum([
  "codex_login",                    // codex-tool login → fresh tokens → import to Sub2API
  "codex_register",                 // codex-tool all → 新账号
  "import_to_sub2api",              // 已有 refresh_token，灌到 Sub2API（试探导入用）
  "import_codex_tool_account",      // P5-AK 接管：从 codex-tool accounts list 导入 + 三分支分流
  "delete_sub2api",                 // DELETE /accounts/{id}
  "toggle_schedulable",             // PUT /accounts/{id}/schedulable
  "observe_usage"                   // GET /accounts/{id}/usage
]);
export type AccountJobKind = z.infer<typeof accountJobKindSchema>;

export const accountJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled"
]);
export type AccountJobStatus = z.infer<typeof accountJobStatusSchema>;

export const accountJobTriggeredBySchema = z.enum(["scheduler", "manual", "adopter"]);
export type AccountJobTriggeredBy = z.infer<typeof accountJobTriggeredBySchema>;

export const accountJobSchema = z.object({
  id: z.string().min(1),
  kind: accountJobKindSchema,
  accountId: z.string().nullable(),
  status: accountJobStatusSchema,
  attempt: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(1),
  priority: z.number().int().default(100),
  scheduledAt: z.string().min(1),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  payloadJson: z.string(),
  resultJson: z.string().nullable(),
  errorMessage: z.string().nullable(),
  /** P5-AT: job 结束时持久化的日志末尾（redact 过），供"最近完成"回看。运行中/未设置为 null。 */
  logTail: z.string().nullable().optional(),
  triggeredBy: accountJobTriggeredBySchema,
  triggeredTickId: z.string().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

export type AccountJob = z.infer<typeof accountJobSchema>;

// ─── Budgets ──────────────────────────────────────

export const accountBudgetRecordSchema = z.object({
  windowKey: z.string().min(1),
  registrationsUsed: z.number().int().nonnegative().default(0),
  registrationsBudget: z.number().int().nonnegative(),
  smsCostCents: z.number().int().nonnegative().default(0),
  resetAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

export type AccountBudgetRecord = z.infer<typeof accountBudgetRecordSchema>;

// ─── Status snapshot for UI ──────────────────────

export const accountFleetStatusSnapshotSchema = z.object({
  spec: accountFleetSpecSchema,
  lastTick: accountFleetTickSchema.optional(),
  recentTicks: z.array(accountFleetTickSummarySchema),
  accounts: z.array(accountRecordViewSchema),
  recentJobs: z.array(accountJobSchema),
  /**
   * 当前 status=running 的 job（P5-AR）。单独拎出来，因为 recentJobs 按时间取最近
   * 50 条，真正在跑的 1~2 个会被一堆 queued 淹没；UI 需要一个明确的"进行中"区。
   */
  runningJobs: z.array(accountJobSchema),
  /** 当前排队中的 job 总数（P5-AR：让用户知道积压规模，不必把全部 queued 塞进列表）。 */
  queuedJobCount: z.number().int().nonnegative().default(0),
  /** 最近"执行完"的 job（P5-AT：按 finished_at 倒序，看执行结果，不被 queued 淹没）。 */
  recentFinishedJobs: z.array(accountJobSchema).default([]),
  /** P6-05: 最近失败原因聚合（按归类计数，降序），让用户不必逐条考古。 */
  recentFailureReasons: z
    .array(
      z.object({
        key: z.enum([
          "deactivated", // OpenAI 确认账号已删除/停用（真死）
          "consent", // 活账号但出口过不了 OAuth consent（缺少目标 URL）
          "sentinel", // 浏览器相位过 Sentinel 失败
          "ratelimit", // OpenAI 限流（Too many tries）
          "region", // 接码地区不可用
          "otp", // 邮箱验证码超时/校验失败（非停用）
          "network", // 纯代理/网络/超时
          "retired", // 已退役死号的残留任务被跳过
          "oauth", // 其它 OAuth 失败
          "other"
        ]),
        count: z.number().int().nonnegative()
      })
    )
    .default([]),
  kpis: z.object({
    totalAccounts: z.number().int().nonnegative(),
    healthyCount: z.number().int().nonnegative(),
    target: z.number().int().nonnegative(),
    brokenCount: z.number().int().nonnegative(),
    recoveringCount: z.number().int().nonnegative(),
    pendingCount: z.number().int().nonnegative(),
    // P6-02 池子分段计数（默认 0 向后兼容）
    quotaExhaustedCount: z.number().int().nonnegative().default(0),
    rateLimitedCount: z.number().int().nonnegative().default(0),
    recoverableCount: z.number().int().nonnegative().default(0),
    deadCount: z.number().int().nonnegative().default(0),
    todayRegistrationsUsed: z.number().int().nonnegative(),
    todayRegistrationsBudget: z.number().int().nonnegative(),
    monthlyRegistrationsUsed: z.number().int().nonnegative(),
    monthlyRegistrationsBudget: z.number().int().nonnegative(),
    /** P5-AI: 当日累计短信成本 cent；月度同。来源是 account_budgets 表。 */
    todaySmsCostCents: z.number().int().nonnegative().default(0),
    monthlySmsCostCents: z.number().int().nonnegative().default(0)
  }),
  /**
   * codex-tool 短信地区经验回灌（透明 blob）。Hive 不解析具体字段，仅在 UI
   * 上展示让用户能看到"上次注册成功的地区 / 时间 / TTL"等 codex-tool 自定义信息。
   * 从未注册过则为 null。
   */
  smsRegionHint: smsRegionHintMemorySchema.nullable()
});

export type AccountFleetStatusSnapshot = z.infer<typeof accountFleetStatusSnapshotSchema>;
