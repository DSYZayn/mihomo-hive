import React from "react";
import {
  Activity,
  AlertOctagon,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  ShieldCheck,
  XCircle
} from "lucide-react";
import type {
  AccountChangeEntry,
  AccountFleetTick,
  AccountFleetStatusSnapshot,
  AccountFleetTickSummary,
  AccountHealth,
  AccountIntent,
  AccountJob,
  AccountOrigin,
  AccountRecordView
} from "@mihomo-hive/schemas";
import { Badge, Button, EmptyState, InfoTip, Pager, Panel, Switch } from "../../components/ui.js";
import { trpc } from "../../lib/trpc.js";

/**
 * 账号编排状态右栏 —— 跟 OrchestrationStatusPanel 同形：
 *   KPI 4 卡 → 账号矩阵 → 最近巡检 feed → 最近 jobs feed
 *
 * 所有操作按钮在左栏；右栏纯展示 + 单条 tick / job 展开详情。
 */
export function AccountFleetStatusPanel(props: {
  snapshot: AccountFleetStatusSnapshot | undefined;
  loading: boolean;
}) {
  if (!props.snapshot && props.loading) {
    return (
      <div className="orchestration-status-panel">
        <Panel title="编排状态">
          <EmptyState
            icon={<Loader2 size={22} className="animate-spin" />}
            title="加载中…"
            description="正在从服务器拉取账号池快照。"
          />
        </Panel>
      </div>
    );
  }

  if (!props.snapshot) {
    return (
      <div className="orchestration-status-panel">
        <Panel title="编排状态">
          <EmptyState
            icon={<Activity size={22} />}
            title="无法拉取账号池状态"
            description="服务可能未启动或网络异常，5 秒后会自动重试。"
          />
        </Panel>
      </div>
    );
  }

  const snap = props.snapshot;

  return (
    <div className="orchestration-status-panel account-fleet-status-panel">
      {/* 顶部 KPI 条(含健康定性)；下方双列：左=账号矩阵+分布条 / 右=信息列。
          分布条放矩阵下方、只占左列宽，不侵占右侧。 */}
      <KpiCards snapshot={snap} />
      <div className="account-fleet-main">
        <div className="account-fleet-matrix-col">
          <AccountMatrix accounts={snap.accounts} lastTick={snap.lastTick} />
          <PoolDistributionBar snapshot={snap} />
        </div>
        <div className="account-fleet-side">
          <SmsRegionHintCard hint={snap.smsRegionHint} kpis={snap.kpis} />
          <RunningJobsCard
            running={snap.runningJobs}
            queuedCount={snap.queuedJobCount}
            accounts={snap.accounts}
            unitCostUsd={snap.spec.registration.maxCostPerAccountUsd}
          />
          <FailureReasonsCard reasons={snap.recentFailureReasons} />
          <RecentFinishedJobsCard jobs={snap.recentFinishedJobs} accounts={snap.accounts} />
          <RecentTicksCard ticks={snap.recentTicks} lastTick={snap.lastTick} />
        </div>
      </div>
    </div>
  );
}

/**
 * 短信地区记忆 + 成本回看（P5-AI / external-integration.md §"成本上限和选区策略"）。
 *
 * Hive 完全透明保存 hint blob，UI 这里做"尽力解析最常见字段"展示 —— 找不到的字段
 * 用 fallback "未提供"。设计原则：哪怕 codex-tool 字段改了，UI 也不应该崩，至少
 * 还能显示 lastUpdatedAt 让用户知道 hint 是新的还是陈旧的。
 *
 * 成本卡片同区放置：今日/本月累计短信成本（Hive 自己累的）— 让用户能看到
 * region_hint 命中是否真的在省钱。
 */
function SmsRegionHintCard(props: {
  hint: AccountFleetStatusSnapshot["smsRegionHint"];
  kpis: AccountFleetStatusSnapshot["kpis"];
}) {
  const { hint, kpis } = props;
  const todayUsd = (kpis.todaySmsCostCents / 100).toFixed(2);
  const monthlyUsd = (kpis.monthlySmsCostCents / 100).toFixed(2);
  const hintObj = hint?.hint && typeof hint.hint === "object" && !Array.isArray(hint.hint)
    ? (hint.hint as Record<string, unknown>)
    : null;
  const country = hintObj && typeof hintObj.country === "string" ? hintObj.country : null;
  // P7：codex-tool 现在回传 country_name(国家名)，运维一眼看懂是哪个地区，光代号看不出
  const countryName =
    hintObj && typeof hintObj.country_name === "string" && hintObj.country_name ? hintObj.country_name : null;
  const operator = hintObj && typeof hintObj.operator === "string" ? hintObj.operator : null;
  const lastSuccessAt = hintObj && typeof hintObj.last_success_at === "string" ? hintObj.last_success_at : null;
  const ttlSeconds =
    hintObj && typeof hintObj.ttl_seconds === "number"
      ? hintObj.ttl_seconds
      : null;
  return (
    <Panel
      title="短信成本与地区记忆"
      hint="codex-tool 自动选区策略：本地保存最近一次注册成功的地区作为下次的优先尝试。具体 TTL / 黑名单逻辑由 codex-tool 决定，Hive 只做透明回传。"
    >
      <div className="form-grid" style={{ gap: 8 }}>
        <div>
          <div className="muted small">今日 SMS 成本</div>
          <div className="mono-strong">${todayUsd}</div>
        </div>
        <div>
          <div className="muted small">本月 SMS 成本</div>
          <div className="mono-strong">${monthlyUsd}</div>
        </div>
        <div>
          <div className="muted small">上次成功地区</div>
          <div className="mono-strong">
            {countryName ? `${countryName}（${country ?? "?"}）` : (country ?? "—")}
            {operator ? ` · ${operator}` : ""}
          </div>
        </div>
        <div>
          <div className="muted small">记忆更新时间</div>
          <div className="small">{hint?.lastUpdatedAt ? new Date(hint.lastUpdatedAt).toLocaleString() : "尚未注册过"}</div>
        </div>
      </div>
      {lastSuccessAt || ttlSeconds ? (
        <div className="muted small" style={{ marginTop: 6 }}>
          {lastSuccessAt ? `codex-tool last_success_at=${lastSuccessAt}` : ""}
          {lastSuccessAt && ttlSeconds ? " · " : ""}
          {ttlSeconds ? `ttl=${ttlSeconds}s` : ""}
        </div>
      ) : null}
    </Panel>
  );
}

/** 池子健康定性（健康数/目标的比例 → 充足/偏紧/严重不足）。供 KPI 卡复用。 */
function poolVerdict(kpis: AccountFleetStatusSnapshot["kpis"]): { label: string; tone: KpiTone } {
  const ratio = kpis.target > 0 ? kpis.healthyCount / kpis.target : 1;
  if (kpis.target === 0) return { label: "未设目标", tone: "neutral" };
  if (ratio >= 0.9) return { label: "充足", tone: "success" };
  if (ratio >= 0.5) return { label: "偏紧", tone: "warning" };
  return { label: "严重不足", tone: "danger" };
}

/**
 * P6-13 账号分布条 —— 放在账号矩阵【下方】，只占左列宽（不侵占右侧信息列）。
 * 一条分段条把池子拆成 健康/可恢复/冷却中/失效/未知 + 图例计数。
 */
function PoolDistributionBar(props: { snapshot: AccountFleetStatusSnapshot }) {
  const { kpis } = props.snapshot;
  const cooling = kpis.quotaExhaustedCount + kpis.rateLimitedCount;
  const unknown = Math.max(
    0,
    kpis.totalAccounts - kpis.healthyCount - kpis.recoverableCount - kpis.deadCount - cooling
  );
  const segments = [
    { key: "healthy", label: "健康", count: kpis.healthyCount, cls: "seg-healthy" },
    { key: "recoverable", label: "可恢复", count: kpis.recoverableCount, cls: "seg-recoverable" },
    { key: "cooling", label: "冷却中", count: cooling, cls: "seg-cooling" },
    { key: "dead", label: "失效", count: kpis.deadCount, cls: "seg-dead" },
    { key: "unknown", label: "未知", count: unknown, cls: "seg-unknown" }
  ].filter((s) => s.count > 0);
  const total = Math.max(1, kpis.totalAccounts);

  return (
    <div className="pool-dist">
      <div className="pool-dist-bar" role="img" aria-label="账号池分布">
        {segments.map((s) => (
          <span
            key={s.key}
            className={`pool-seg ${s.cls}`}
            style={{ width: `${(s.count / total) * 100}%` }}
            title={`${s.label} ${s.count}`}
          />
        ))}
      </div>
      <div className="pool-dist-legend">
        {segments.map((s) => (
          <span key={s.key} className="pool-legend-item">
            <span className={`pool-legend-dot ${s.cls}`} />
            {s.label} <strong>{s.count}</strong>
          </span>
        ))}
        <span className="pool-legend-item muted">共 {kpis.totalAccounts}</span>
        {cooling > 0 ? <span className="pool-legend-item muted">· 冷却中会自然恢复</span> : null}
      </div>
    </div>
  );
}

function KpiCards(props: { snapshot: AccountFleetStatusSnapshot }) {
  const { kpis } = props.snapshot;

  const dailyRatio =
    kpis.todayRegistrationsBudget > 0 ? kpis.todayRegistrationsUsed / kpis.todayRegistrationsBudget : 0;
  const budgetTone: KpiTone =
    kpis.todayRegistrationsBudget === 0
      ? "neutral"
      : dailyRatio >= 1
        ? "danger"
        : dailyRatio >= 0.8
          ? "warning"
          : "success";
  const recoveringTone: KpiTone = kpis.recoveringCount === 0 ? "neutral" : "warning";
  const monthlyRatioPct =
    kpis.monthlyRegistrationsBudget > 0
      ? Math.round((kpis.monthlyRegistrationsUsed / kpis.monthlyRegistrationsBudget) * 100)
      : 0;
  const verdict = poolVerdict(kpis);

  // 健康定性置于首位，其余为活动/成本/吞吐；详细分布在矩阵下方的分布条。
  return (
    <section className="kpi-grid kpi-grid-fleet">
      <KpiCard
        title="健康账号"
        primary={`${kpis.healthyCount} / ${kpis.target || "—"}`}
        secondary={verdict.label}
        tone={verdict.tone}
      />
      <KpiCard
        title="修复中"
        primary={String(kpis.recoveringCount)}
        secondary={kpis.recoveringCount === 0 ? "无任务" : "登录/注册修复中"}
        tone={recoveringTone}
      />
      <KpiCard
        title="今日成功注册"
        primary={`${kpis.todayRegistrationsUsed} / ${kpis.todayRegistrationsBudget}`}
        secondary={describeBudgetTone(budgetTone, dailyRatio) + "（失败不计入）"}
        tone={budgetTone}
      />
      <KpiCard
        title="今日花费"
        primary={`$${(kpis.todaySmsCostCents / 100).toFixed(2)}`}
        secondary={`本月 $${(kpis.monthlySmsCostCents / 100).toFixed(2)} · 含失败取号`}
        tone="neutral"
      />
      <KpiCard
        title="本月成功注册"
        primary={`${kpis.monthlyRegistrationsUsed} / ${kpis.monthlyRegistrationsBudget}`}
        secondary={kpis.monthlyRegistrationsBudget === 0 ? "未设月上限" : `占月上限 ${monthlyRatioPct}%`}
        tone="neutral"
      />
    </section>
  );
}

function describeBudgetTone(tone: KpiTone, ratio: number): string {
  if (tone === "neutral") return "未设日预算";
  if (tone === "danger") return "已耗尽，停止注册";
  if (tone === "warning") return `占 ${Math.round(ratio * 100)}%，接近上限`;
  return `占 ${Math.round(ratio * 100)}%，充裕`;
}

type MatrixFilterKey = "attention" | "changed" | "all" | "healthy" | "broken" | "recovering" | "cooling";

/** "最近有变动"窗口：newest change 落在这个时间内才算近期变动。 */
const RECENT_CHANGE_WINDOW_MS = 24 * 60 * 60 * 1000;

const MATRIX_FILTERS: { key: MatrixFilterKey; label: string; match: (a: AccountRecordView) => boolean }[] = [
  {
    key: "attention",
    label: "需关注",
    // 只看"还能动手"的：可恢复的掉线(未退役) / 正在修复 / 被限流。已退役死号不算需关注。
    match: (a) =>
      (a.health === "broken" && a.intent !== "retired") ||
      a.intent === "recovering" ||
      a.health === "rate_limited"
  },
  {
    key: "changed",
    label: "最近有变动",
    // 最近一次真实变动（health/intent/额度）落在 24h 内 —— 由 change_history 头条时间判定
    match: (a) => {
      const ms = matrixChangeMs(a);
      return ms > 0 && Date.now() - ms <= RECENT_CHANGE_WINDOW_MS;
    }
  },
  { key: "all", label: "全部", match: () => true },
  { key: "healthy", label: "健康", match: (a) => a.health === "healthy" },
  { key: "broken", label: "掉线", match: (a) => a.health === "broken" },
  { key: "recovering", label: "修复中", match: (a) => a.intent === "recovering" },
  { key: "cooling", label: "冷却中", match: (a) => a.health === "quota_exhausted" || a.health === "rate_limited" }
];


function AccountMatrix(props: { accounts: AccountRecordView[]; lastTick: AccountFleetTick | undefined }) {
  const [filter, setFilter] = React.useState<MatrixFilterKey>("attention");
  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState(50);

  const q = query.trim().toLowerCase();
  const activeMatch = (MATRIX_FILTERS.find((f) => f.key === filter) ?? MATRIX_FILTERS[1]!).match;
  const filtered = React.useMemo(() => {
    const base = props.accounts.filter((a) => activeMatch(a));
    const searched = q
      ? base.filter(
          (a) => a.email.toLowerCase().includes(q) || (a.externalId ? String(a.externalId).includes(q) : false)
        )
      : base;
    // "最近有变动"筛选下：纯按变更时间降序，让刚变动的账号置顶（这正是该视图的用途）。
    if (filter === "changed") {
      return [...searched].sort((a, b) => matrixChangeMs(b) - matrixChangeMs(a));
    }
    // P6-10 排序：按"用户最关心 + 最近有变动"——正在修复→可恢复掉线→限流→健康→
    // 配额冷却→已退役死号(沉底)；同档内按真实变更/事件时间降序，让刚发生变化的浮到前面。
    // 不用 updatedAt(每 tick 全量刷新，无区分度)。
    return [...searched].sort(
      (a, b) => matrixActivityRank(a) - matrixActivityRank(b) || matrixRecencyMs(b) - matrixRecencyMs(a)
    );
  }, [props.accounts, activeMatch, filter, q]);

  // filter/search 变化时回到第 1 页
  React.useEffect(() => setPage(0), [filter, q]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(safePage * pageSize, (safePage + 1) * pageSize);

  const chipBar = (
    <div className="matrix-toolbar">
      <div className="matrix-chips">
        {MATRIX_FILTERS.map((f) => {
          const count = props.accounts.filter((a) => f.match(a)).length;
          return (
            <button
              key={f.key}
              type="button"
              className={`matrix-chip${filter === f.key ? " is-active" : ""}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label} <span className="matrix-chip-count">{count}</span>
            </button>
          );
        })}
      </div>
      <input
        type="search"
        className="matrix-search"
        placeholder="搜索邮箱 / 账号 ID"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="搜索账号"
      />
    </div>
  );

  if (props.accounts.length === 0) {
    return (
      <Panel title="账号矩阵" className="status-pane-matrix">
        <EmptyState
          title="账号池为空"
          description="开启自动维护后会按策略自动注册补给；也可在「设置与工具」导入存量 Sub2API 账号，或用上方「注册一批」立即补给。"
        />
      </Panel>
    );
  }

  return (
    <Panel
      title={`账号矩阵 ${filtered.length}/${props.accounts.length}`}
      className="status-pane-matrix"
      actions={
        props.lastTick ? (
          <span className="muted small">
            上次巡检 {new Date(props.lastTick.startedAt).toLocaleTimeString()} · 计划 {props.lastTick.plannedTotal} · 入队{" "}
            {props.lastTick.appliedTotal}
          </span>
        ) : (
          <span className="muted small">尚未巡检</span>
        )
      }
    >
      {chipBar}
      {filtered.length === 0 ? (
        <EmptyState title="没有符合条件的账号" description="换个筛选或清空搜索试试。" />
      ) : (
        <div className="node-matrix-scroll">
          <table className="node-matrix-table account-matrix-table">
            <thead>
              <tr>
                <th>邮箱</th>
                <th>来源</th>
                <th>状态</th>
                <th>健康</th>
                <th className="num">配额 5h/7d</th>
                <th className="num">存活/重登</th>
                <th>最近变动</th>
                <th>出口节点</th>
                <th>自动运维</th>
              </tr>
            </thead>
            <tbody>
            {pageRows.map((acc) => {
              const split = splitOrigin(acc.origin);
              const egressTitle = formatEgressTooltip(acc);
              return (
              <tr key={acc.id} className={`node-matrix-tr role-${rowRoleByHealth(acc.health)}`}>
                <td className="cell-name" title={acc.email}>
                  {acc.email.startsWith("unknown-") ? (
                    // 接管时 Sub2API 未返回 email 的账号（多为已下线 / 无凭据的残留记录）。
                    // 不显示丑陋的 unknown-177，改成"无邮箱记录"+ 账号编号。
                    <span className="muted">无邮箱记录</span>
                  ) : (
                    <span className="mono-strong">{acc.email}</span>
                  )}
                  {acc.externalId ? <span className="muted small"> #{acc.externalId}</span> : null}
                </td>
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                    <Badge tone={split.typeTone}>{split.typeLabel}</Badge>
                    {split.subLabel ? (
                      <span className="muted small" style={{ marginLeft: 4 }}>· {split.subLabel}</span>
                    ) : null}
                    <InfoTip text={split.tooltip} />
                  </span>
                </td>
                <td>
                  <RecoverStatus acc={acc} />
                </td>
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
                    {(() => {
                      const remain = recoveryRemainingLabel(acc);
                      // 限流中 → 健康标签与恢复时间合并成一个标签，竖杠连接
                      return remain ? (
                        <>
                          <Badge tone={HEALTH_TONE[acc.health]}>
                            {HEALTH_LABEL[acc.health]} | {remain}
                          </Badge>
                          <InfoTip text={recoveryTooltip(acc)} />
                        </>
                      ) : (
                        <>
                          <HealthBadge health={acc.health} />
                          {acc.lastRecoveryFailureCategory ? (
                            <InfoTip text={formatFailureCategory(acc.lastRecoveryFailureCategory)} />
                          ) : null}
                        </>
                      );
                    })()}
                  </span>
                </td>
                <td className="num">
                  <span className={`mono-strong ${quotaToneClass(acc.quota5hPercent)}`}>
                    {acc.quota5hPercent !== null ? `${acc.quota5hPercent}%` : "—"}
                  </span>
                  <span className="muted"> / </span>
                  <span className={`mono-strong ${quotaToneClass(acc.quota7dPercent)}`}>
                    {acc.quota7dPercent !== null ? `${acc.quota7dPercent}%` : "—"}
                  </span>
                </td>
                <td className="num cell-alive">
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
                    {/* 掉线账号存活已冻结 → 灰显（不再用"·停"文字占地方），具体掉线时间在 ℹ️ 里 */}
                    <span className={aliveFrozenAtMs(acc) !== null ? "muted" : "mono-strong"}>
                      {formatDaysAlive(acc)}
                    </span>
                    {acc.reloginCount > 0 ? (
                      <span className="muted small" title={`累计重新登录 ${acc.reloginCount} 次`}>
                        ↻{acc.reloginCount}
                      </span>
                    ) : null}
                    <InfoTip text={formatQualityTooltip(acc)} />
                  </span>
                </td>
                <td className="cell-change">
                  {(() => {
                    const head = acc.changeHistory?.[0];
                    if (!head) return <span className="muted">—</span>;
                    const b = changeBrief(head);
                    return (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <span className={`small ${b.cls}`} style={{ fontWeight: 600 }}>
                          {b.text}
                        </span>
                        <span className="muted small">{shortAgo(head.at)}</span>
                        <InfoTip text={changeHistoryTooltip(acc)} />
                      </span>
                    );
                  })()}
                </td>
                <td className="cell-sub2api" title={egressTitle}>
                  {acc.currentNodeName ? (
                    <span className="mono-strong" style={{ cursor: "help" }}>{acc.currentNodeName}</span>
                  ) : acc.currentProxyId ? (
                    // Sub2API 关联到了代理，但本地节点表里没有这个 proxy_id（可能是 Sub2API
                    // 远端另有代理 / 本地尚未推送 / 节点已删除）
                    <span className="muted small" style={{ cursor: "help" }}>外部代理 #{acc.currentProxyId}</span>
                  ) : acc.egressNodeHash ? (
                    // 仅 codex-tool 路径会写，软粘性记录"上次注册/登录走哪个节点出口"
                    <span className="muted small" style={{ cursor: "help" }}>上次出口 {acc.egressNodeHash.slice(0, 8)}</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                    <OpsToggle acc={acc} />
                    <TestLoginButton acc={acc} />
                  </span>
                </td>
              </tr>
              );
            })}
            </tbody>
          </table>
        </div>
      )}
      {filtered.length > 0 ? (
        <div className="matrix-pager">
          <Pager
            page={safePage}
            pageCount={pageCount}
            total={filtered.length}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(s) => {
              setPageSize(s);
              setPage(0);
            }}
          />
        </div>
      ) : null}
    </Panel>
  );
}

/** 单账号运维开关：开=接受自动化任务分配,关=暂停该账号一切自动恢复/重绑。 */
function OpsToggle(props: { acc: AccountRecordView }) {
  const utils = trpc.useUtils();
  const m = trpc.accountFleet.actions.setOpsEnabled.useMutation({
    onSuccess: () => void utils.accountFleet.status.invalidate()
  });
  const on = props.acc.opsEnabled;
  return (
    <Switch
      checked={on}
      disabled={m.isPending}
      title={on ? "运维开:点此暂停该账号的自动化(恢复/重绑)分配" : "运维已暂停:点此恢复该账号的自动化分配"}
      onChange={(v) => m.mutate({ accountId: props.acc.id, enabled: v })}
      label={on ? undefined : "暂停"}
    />
  );
}

/** 手动触发一次 codex_login(测试/实验用,要求账号有 phone+password)。 */
function TestLoginButton(props: { acc: AccountRecordView }) {
  const utils = trpc.useUtils();
  const m = trpc.accountFleet.actions.enqueueRecoverLogin.useMutation({
    onSuccess: () => void utils.accountFleet.status.invalidate()
  });
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={m.isPending}
      title="立刻给该账号入队一次 codex_login(测试登录闭环/抓取 step-up 结构;要求账号有手机号+密码)。"
      onClick={() => m.mutate({ accountId: props.acc.id })}
    >
      登录
    </Button>
  );
}

type FleetFeedItem =
  | { kind: "tick"; tick: AccountFleetTickSummary }
  | { kind: "paused_run"; count: number; latestAt: string; earliestAt: string }
  | { kind: "no_change_run"; count: number; latestAt: string; earliestAt: string };

/**
 * 把连续的 paused（自动维护未开启）/ no_change tick 合并成单行占位，
 * 给真有动作的 tick 让出空间。ticks 是按 startedAt 倒序。
 */
function mergeIdleRuns(ticks: AccountFleetTickSummary[]): FleetFeedItem[] {
  const items: FleetFeedItem[] = [];
  let pausedRun: { count: number; latestAt: string; earliestAt: string } | null = null;
  let ncRun: { count: number; latestAt: string; earliestAt: string } | null = null;
  function flushPaused() {
    if (pausedRun) {
      items.push({ kind: "paused_run", ...pausedRun });
      pausedRun = null;
    }
  }
  function flushNc() {
    if (ncRun) {
      items.push({ kind: "no_change_run", ...ncRun });
      ncRun = null;
    }
  }
  for (const tick of ticks) {
    if (tick.skippedReason === "paused") {
      flushNc();
      if (!pausedRun) pausedRun = { count: 1, latestAt: tick.startedAt, earliestAt: tick.startedAt };
      else {
        pausedRun.count += 1;
        pausedRun.earliestAt = tick.startedAt;
      }
    } else if (tick.skippedReason === "no_change") {
      flushPaused();
      if (!ncRun) ncRun = { count: 1, latestAt: tick.startedAt, earliestAt: tick.startedAt };
      else {
        ncRun.count += 1;
        ncRun.earliestAt = tick.startedAt;
      }
    } else {
      flushPaused();
      flushNc();
      items.push({ kind: "tick", tick });
    }
  }
  flushPaused();
  flushNc();
  return items;
}

/** P6-11 本轮巡检规划摘要：把 lastTick.plannedActions 按动作类型聚合成 chips —— 比一排
 *  "计划68/入队37" 重复行有意义得多，直接告诉用户系统这一轮在做什么。 */
function TickActionBreakdown(props: { tick: AccountFleetTick }) {
  const counts = new Map<string, number>();
  for (const a of props.tick.plannedActions) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
  // 把"实际动手"的排前面，观察/延后这类只读动作排后并弱化
  const order = [
    "recover_via_login",
    "recover_via_register",
    "register_new",
    "retire",
    "delete_external",
    "demote_to_observing",
    "toggle_schedulable",
    "defer",
    "observe_usage"
  ];
  const passive = new Set(["defer", "observe_usage"]);
  const entries = [...counts.entries()].sort(
    (a, b) => order.indexOf(a[0]) - order.indexOf(b[0])
  );
  if (entries.length === 0) {
    return <div className="muted small">本轮无规划动作（池子稳定 / 已暂停）。</div>;
  }
  return (
    <div className="tick-breakdown">
      {entries.map(([kind, n]) => (
        <span key={kind} className={`tick-bd-chip${passive.has(kind) ? " is-passive" : ""}`}>
          {tickActionLabel(kind as AccountFleetTick["plannedActions"][number]["kind"])}
          <strong>{n}</strong>
        </span>
      ))}
    </div>
  );
}

function RecentTicksCard(props: { ticks: AccountFleetTickSummary[]; lastTick: AccountFleetTick | undefined }) {
  const [historyOpen, setHistoryOpen] = React.useState(false);
  if (props.ticks.length === 0) {
    return (
      <Panel title="巡检活动">
        <EmptyState title="尚未跑过巡检" description="开启自动维护后每 5 分钟自动巡检一次。" />
      </Panel>
    );
  }
  const items = mergeIdleRuns(props.ticks);
  return (
    <Panel title="巡检活动" className="status-pane-feed">
      {props.lastTick ? (
        <div className="tick-current">
          <div className="muted small" style={{ marginBottom: 4 }}>
            本轮规划（{new Date(props.lastTick.startedAt).toLocaleTimeString()} · 入队 {props.lastTick.appliedTotal}/
            {props.lastTick.plannedTotal}）
          </div>
          <TickActionBreakdown tick={props.lastTick} />
        </div>
      ) : null}
      <button type="button" className="tick-history-toggle" onClick={() => setHistoryOpen((v) => !v)}>
        {historyOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />} 历史巡检（{props.ticks.length}）
      </button>
      {historyOpen ? (
      <div className="reconcile-feed">
        {items.map((item, idx) => {
          if (item.kind === "paused_run" || item.kind === "no_change_run") {
            const fromTs = new Date(item.earliestAt).toLocaleTimeString();
            const toTs = new Date(item.latestAt).toLocaleTimeString();
            const sameMoment = fromTs === toTs;
            const label = item.kind === "paused_run" ? "自动维护未开启" : "无变更";
            return (
              <article
                key={`run-${idx}`}
                className={`reconcile-row reconcile-${item.kind === "paused_run" ? "paused" : "no_change"} reconcile-run`}
              >
                <div className="reconcile-row-head reconcile-run-head">
                  <ShieldCheck size={14} aria-hidden="true" />
                  <span className="muted small">
                    {item.count} 次 {label}（{sameMoment ? toTs : `${fromTs} – ${toTs}`}）
                  </span>
                </div>
              </article>
            );
          }
          return <TickRow key={item.tick.id} tick={item.tick} />;
        })}
      </div>
      ) : null}
    </Panel>
  );
}

function TickRow(props: { tick: AccountFleetTickSummary }) {
  const tick = props.tick;
  const [open, setOpen] = React.useState(false);
  // 有计划/入队动作或报错才值得展开；否则保持纯展示行（不给可点的假象）。
  const expandable = tick.plannedTotal > 0 || tick.appliedTotal > 0 || Boolean(tick.errorMessage);
  // 展开时才按 id 拉完整 tick（含 plannedActions / appliedActions 明细）
  const detail = trpc.accountFleet.tick.get.useQuery(
    { id: tick.id },
    { enabled: open && expandable, staleTime: 60_000 }
  );

  const head = (
    <>
      {expandable ? open ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <span style={{ width: 14 }} />}
      <SkippedIcon skipped={tick.skippedReason} />
      <span className="font-mono muted small">{new Date(tick.startedAt).toLocaleTimeString()}</span>
      <span>{summarizeTick(tick)}</span>
      <SkippedBadge skipped={tick.skippedReason} />
    </>
  );

  return (
    <article className={`reconcile-row reconcile-${tick.skippedReason}`}>
      {expandable ? (
        <button type="button" className="reconcile-row-head" onClick={() => setOpen((o) => !o)}>
          {head}
        </button>
      ) : (
        <div className="reconcile-row-head">{head}</div>
      )}
      {open && expandable ? (
        <div className="reconcile-row-body">
          {tick.errorMessage ? <div className="form-error">{tick.errorMessage}</div> : null}
          {detail.isLoading ? <span className="muted small">加载明细…</span> : null}
          {detail.data ? <TickDetail tick={detail.data} /> : null}
          {detail.isError ? <span className="muted small">明细加载失败</span> : null}
        </div>
      ) : null}
    </article>
  );
}

/** tick 展开明细：本轮计划/已入队的账号动作（kind + email + 原因）。 */
function TickDetail(props: { tick: AccountFleetTick }) {
  const { tick } = props;
  // 已入队动作优先展示（真正执行的）；其余落在"已计划未入队"。用 accountId+kind 去重交集。
  const appliedKeys = new Set(tick.appliedActions.map((a) => `${a.kind}:${a.accountId ?? a.externalId ?? a.email}`));
  const plannedOnly = tick.plannedActions.filter(
    (a) => !appliedKeys.has(`${a.kind}:${a.accountId ?? a.externalId ?? a.email}`)
  );
  if (tick.appliedActions.length === 0 && plannedOnly.length === 0) {
    return <span className="muted small">本轮无账号动作（仅观察）。</span>;
  }
  return (
    <div className="tick-detail">
      {tick.appliedActions.length > 0 ? (
        <ActionGroup title={`已入队 (${tick.appliedActions.length})`} actions={tick.appliedActions} tone="success" />
      ) : null}
      {plannedOnly.length > 0 ? (
        <ActionGroup title={`已计划未入队 (${plannedOnly.length})`} actions={plannedOnly} tone="neutral" />
      ) : null}
    </div>
  );
}

function ActionGroup(props: {
  title: string;
  actions: AccountFleetTick["plannedActions"];
  tone: "success" | "neutral";
}) {
  return (
    <div className="tick-action-group">
      <div className="muted small">
        <Badge tone={props.tone}>{props.title}</Badge>
      </div>
      <ul className="reconcile-change-list">
        {props.actions.slice(0, 50).map((a, i) => (
          <li key={i} className="tick-action-item">
            <span className="font-mono">{tickActionLabel(a.kind)}</span>
            <span className="muted">{a.email ?? (a.externalId ? `#${a.externalId}` : a.accountId?.slice(0, 8) ?? "—")}</span>
            <span className="muted small">{a.reason}</span>
          </li>
        ))}
        {props.actions.length > 50 ? (
          <li className="muted small">…另有 {props.actions.length - 50} 条</li>
        ) : null}
      </ul>
    </div>
  );
}

function tickActionLabel(kind: AccountFleetTick["plannedActions"][number]["kind"]): string {
  const map: Record<string, string> = {
    demote_to_observing: "降级观察",
    recover_via_login: "登录修复",
    recover_via_register: "重注册修复",
    register_new: "新建注册",
    retire: "退役",
    delete_external: "删 Sub2API",
    toggle_schedulable: "切调度位",
    observe_usage: "查配额",
    defer: "延后重试"
  };
  return map[kind] ?? kind;
}

/**
 * P5-AW 手动注册控件 —— 立刻入队一批 codex_register 并插队到所有任务前面
 * (priority=5)，不受自动注册开关门控。用于"现在就补一批健康账号"。
 */
function RegisterControl(props: { unitCostUsd: number }) {
  const [count, setCount] = React.useState(5);
  const [confirming, setConfirming] = React.useState(false);
  const utils = trpc.useUtils();
  const refresh = () => void utils.accountFleet.status.invalidate();
  const reg = trpc.accountFleet.actions.enqueueRegisterNew.useMutation({
    onSuccess: () => {
      setConfirming(false);
      refresh();
    }
  });
  const regen = trpc.accountFleet.actions.regenerateQueue.useMutation({ onSuccess: refresh });
  const stopAll = trpc.accountFleet.actions.setAllOpsEnabled.useMutation({ onSuccess: refresh });
  const [confirmStop, setConfirmStop] = React.useState(false);
  const estCost = (count * props.unitCostUsd).toFixed(2);

  // 二次确认态：花真金白银取号，必须让用户确认数量与预计花费
  if (confirming) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span className="small">
          注册 <strong>{count}</strong> 个 · 预计接码 ≤ <strong>${estCost}</strong>?
        </span>
        <Button
          size="sm"
          variant="primary"
          loading={reg.isPending}
          onClick={() => reg.mutate({ count, jumpQueue: true })}
        >
          确认注册
        </Button>
        <Button size="sm" variant="ghost" disabled={reg.isPending} onClick={() => setConfirming(false)}>
          取消
        </Button>
      </span>
    );
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <input
        type="number"
        min={1}
        max={50}
        value={count}
        onChange={(e) => setCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
        style={{ width: 52 }}
        aria-label="注册数量"
        title="一次注册几个新账号"
      />
      <Button
        size="sm"
        variant="secondary"
        title="立刻注册 N 个新账号并插队到所有队列任务前面。每个账号都会向接码平台取号、产生费用。"
        onClick={() => setConfirming(true)}
      >
        立即注册
      </Button>
      <Button
        size="sm"
        variant="ghost"
        loading={regen.isPending}
        title="取消所有排队中的恢复任务并按当前策略重新规划队列。用于调整均衡度/策略后，或旧队列被陈旧重复任务卡住时一键重置。"
        onClick={() => regen.mutate()}
      >
        重新编排
      </Button>
      {confirmStop ? (
        <Button
          size="sm"
          variant="danger"
          loading={stopAll.isPending}
          title="把所有现有账号的运维关掉并清掉它们已排队的任务,彻底隔离。之后用每行的'已暂停→运维开'按钮把少量测试账号开回来,或注册新号(新号默认开)。"
          onClick={() => stopAll.mutate({ enabled: false, onlyNonActive: false }, { onSettled: () => setConfirmStop(false) })}
        >
          确认停掉全部?
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          title="停掉所有现有账号的自动化运维并清掉已排队任务(隔离实验用)。之后手动开回少量做测试。"
          onClick={() => setConfirmStop(true)}
        >
          停掉全部账号
        </Button>
      )}
    </span>
  );
}

/**
 * P5-AR「进行中」卡片 —— 把真正在跑的 job 从一堆 queued 里单独拎出来。
 * 显示 kind / 账号 / 已运行时长 / 尝试次数 + 当前排队积压。
 * 已运行时长随每次 snapshot 轮询（5s）刷新；超过阈值标黄/红提示疑似卡死。
 */
function RunningJobsCard(props: {
  running: AccountJob[];
  queuedCount: number;
  accounts: AccountRecordView[];
  unitCostUsd: number;
}) {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const emailById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const a of props.accounts) m.set(a.id, a.email);
    return m;
  }, [props.accounts]);

  const title = `进行中 (${props.running.length})${props.queuedCount > 0 ? ` · 排队 ${props.queuedCount}` : ""}`;

  if (props.running.length === 0) {
    return (
      <Panel title={title} actions={<RegisterControl unitCostUsd={props.unitCostUsd} />}>
        <EmptyState
          title="当前无运行中的 job"
          description={
            props.queuedCount > 0
              ? `有 ${props.queuedCount} 个任务排队中，worker 受并发上限串行消费，稍候会逐个进入运行。`
              : "队列为空。掉线账号会在下个巡检 tick 入队恢复任务。"
          }
        />
      </Panel>
    );
  }

  return (
    <Panel title={title} actions={<RegisterControl unitCostUsd={props.unitCostUsd} />}>
      <div className="reconcile-feed">
        {props.running.map((job) => {
          const email = job.accountId ? emailById.get(job.accountId) : undefined;
          const who = email && !email.startsWith("unknown-") ? email : job.accountId?.slice(0, 12) ?? "—";
          const elapsed = job.startedAt ? Date.now() - new Date(job.startedAt).getTime() : 0;
          const tone = elapsed > 240_000 ? "danger" : elapsed > 120_000 ? "warning" : "info";
          const isOpen = expanded.has(job.id);
          return (
            <article key={job.id} className="reconcile-row reconcile-running">
              <button
                type="button"
                className="reconcile-row-head"
                onClick={() => toggle(job.id)}
              >
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Loader2 size={14} className="animate-spin" />
                <span>
                  <strong>{jobKindLabel(job.kind)}</strong>
                  <span className="muted small"> · {who}</span>
                </span>
                <span className="muted small">尝试 {job.attempt}/{job.maxAttempts}</span>
                <Badge tone={tone}>已运行 {formatElapsed(elapsed)}</Badge>
              </button>
              {isOpen ? (
                <div className="reconcile-row-body">
                  <JobLogView jobId={job.id} live />
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </Panel>
  );
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem.toString().padStart(2, "0")}s`;
}

/**
 * P5-AT: job 实时日志视图。运行中 → 每 2s 轮询进程内缓冲；已结束 → 拉一次
 * 持久化 log_tail。展示 worker 里程碑 + codex-tool stderr 进度（已 redact）。
 */
function JobLogView(props: { jobId: string; live?: boolean }) {
  const q = trpc.accountFleet.jobLog.useQuery(
    { jobId: props.jobId },
    { refetchInterval: props.live ? 2000 : false }
  );
  const lines = q.data?.lines ?? [];
  if (q.isLoading) return <div className="muted small" style={{ padding: "6px 12px" }}>加载日志…</div>;
  if (lines.length === 0) {
    return <div className="muted small" style={{ padding: "6px 12px" }}>暂无日志输出。</div>;
  }
  return (
    <pre className="job-log-view">
      {lines.map((l, i) => (
        <div key={i}>
          {l.ts ? <span className="muted">{l.ts.slice(11, 19)} </span> : null}
          {l.text}
        </div>
      ))}
    </pre>
  );
}

/**
 * P5-AT「最近完成」卡片 —— 按 finished_at 倒序展示执行完的 job（区别于按入队时间
 * 排序、被一堆 queued 淹没的旧"最近 jobs"）。展开看持久化日志 + 错误信息。
 */
const FAILURE_REASON_META: Record<
  AccountFleetStatusSnapshot["recentFailureReasons"][number]["key"],
  { label: string; hint: string; tone: "danger" | "warning" | "neutral" }
> = {
  deactivated: { label: "账号已停用", tone: "danger", hint: "OpenAI 在邮箱验证码校验时返回 403「账号已删除/停用」(deleted or deactivated)——这是确定的死号信号,已退役、不再重试。这是唯一会触发退役的失败类。" },
  consent: { label: "出口过不了 consent", tone: "warning", hint: "账号是活的(已过 OpenAI 的 OTP 校验),但我方出口在 OAuth consent 那步拿不到跳转 URL(缺少目标 URL)。实测对出口 IP 敏感——干净/住宅 IP 能过、机房 IP 多被挡。不退役,换干净出口可救。" },
  sentinel: { label: "Sentinel/浏览器", tone: "warning", hint: "桌面浏览器在过 Cloudflare Sentinel 那步失败,或到 OpenAI 的连接被重置。多为出口问题,不退役、可重试。" },
  ratelimit: { label: "OpenAI 限流", tone: "warning", hint: "OpenAI 返回「Too many tries / 请稍后再试」——多为短时间内对同一账号反复校验 OTP/频繁登录触发。账号没坏,等待较久后再试。" },
  region: { label: "接码地区不可用", tone: "warning", hint: "接码地区取不到号/收不到码。地区经验会逐步累积避开坏区,或检查接码平台余额。" },
  otp: { label: "邮箱验证码", tone: "warning", hint: "邮箱验证码超时或校验失败(非停用)。检查 SkyMail 投递;注意不要对同一 OTP 反复校验(会被 OpenAI 限流)。" },
  network: { label: "代理 / 网络", tone: "warning", hint: "纯代理/网络/超时类。检查出口代理连通性。" },
  retired: { label: "已退役跳过", tone: "neutral", hint: "死号的残留任务被执行前拦下跳过,属正常清理,不消耗资源。" },
  oauth: { label: "OAuth 失败", tone: "warning", hint: "授权环节其它失败,按退避自动重试。" },
  other: { label: "其它", tone: "neutral", hint: "未归类的失败,可展开「最近完成」看具体日志。" }
};

/**
 * P6-05 失败原因聚合卡 —— 最近失败按归类计数，让用户一眼看出"主要卡在哪"+ 下一步，
 * 不必逐条展开日志考古。
 */
function FailureReasonsCard(props: { reasons: AccountFleetStatusSnapshot["recentFailureReasons"] }) {
  const reasons = props.reasons.filter((r) => r.count > 0);
  if (reasons.length === 0) {
    return (
      <Panel title="失败原因">
        <EmptyState title="近期无失败" description="最近的任务都成功或还没失败记录。" />
      </Panel>
    );
  }
  const total = reasons.reduce((s, r) => s + r.count, 0);
  return (
    <Panel title={`失败原因（近 ${total}）`}>
      <ul className="failure-reason-list">
        {reasons.map((r) => {
          const meta = FAILURE_REASON_META[r.key];
          return (
            <li key={r.key} className="failure-reason-item">
              <div className="failure-reason-head">
                <Badge tone={meta.tone}>{meta.label}</Badge>
                <strong className="failure-reason-count">{r.count}</strong>
              </div>
              <div className="muted small">{meta.hint}</div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function RecentFinishedJobsCard(props: { jobs: AccountJob[]; accounts: AccountRecordView[] }) {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const emailById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const a of props.accounts) m.set(a.id, a.email);
    return m;
  }, [props.accounts]);
  if (props.jobs.length === 0) {
    return (
      <Panel title="最近完成">
        <EmptyState
          title="尚无执行完的 job"
          description="job 执行结束（成功/失败）后会按完成时间出现在这里，可展开看日志与错误。"
        />
      </Panel>
    );
  }
  return (
    <Panel title={`最近完成 (${props.jobs.length})`}>
      <div className="reconcile-feed">
        {props.jobs.slice(0, 25).map((job) => {
          const isOpen = expanded.has(job.id);
          const email = job.accountId ? emailById.get(job.accountId) : undefined;
          const who = email && !email.startsWith("unknown-") ? email : job.accountId?.slice(0, 12);
          return (
            <article key={job.id} className={`reconcile-row reconcile-${jobReason(job.status)}`}>
              <button
                type="button"
                className="reconcile-row-head"
                onClick={() =>
                  setExpanded((cur) => {
                    const next = new Set(cur);
                    if (next.has(job.id)) next.delete(job.id);
                    else next.add(job.id);
                    return next;
                  })
                }
              >
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <JobStatusIcon status={job.status} />
                <span className="font-mono muted small">
                  {job.finishedAt ? new Date(job.finishedAt).toLocaleTimeString() : ""}
                </span>
                <span>
                  <strong>{jobKindLabel(job.kind)}</strong>
                  {who ? <span className="muted small"> · {who}</span> : null}
                </span>
                <Badge tone={jobBadgeTone(job.status)}>{jobStatusLabel(job.status)}</Badge>
              </button>
              {isOpen ? (
                <div className="reconcile-row-body">
                  <ul className="reconcile-change-list">
                    <li className="muted small">
                      触发 {job.triggeredBy} · 尝试 {job.attempt}/{job.maxAttempts}
                      {job.durationMs !== null ? ` · 耗时 ${(job.durationMs / 1000).toFixed(1)}s` : ""}
                    </li>
                    {job.errorMessage ? (
                      <li>
                        <span className="form-error">{job.errorMessage}</span>
                      </li>
                    ) : null}
                  </ul>
                  <JobLogView jobId={job.id} />
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </Panel>
  );
}

// ─── badges / icons ───────────────────────────────

type KpiTone = "success" | "warning" | "danger" | "neutral";

function KpiCard(props: { title: string; primary: string; secondary: string; tone: KpiTone }) {
  return (
    <div className={`kpi-card kpi-${props.tone}`}>
      <div className="kpi-title">{props.title}</div>
      <div className="kpi-primary">{props.primary}</div>
      <div className="kpi-secondary">{props.secondary}</div>
    </div>
  );
}

/**
 * 账号来源（P5-AG 第二轮）—— 旧设计把 origin 拆成「类型 + 接管子类」两列，
 * 用户反馈"看到所有账号都是'接管'完全不知道什么意思"。新设计：合并成一列，
 *   主标 = 这账号是怎么进系统的
 *   副标 = 凭据/恢复状态（仅 adopted_* 有意义时显示）
 *   tooltip = 完整含义说明，让"接管"不再是黑话
 */
function splitOrigin(origin: AccountOrigin): {
  typeLabel: string;
  typeTone: "success" | "warning" | "danger" | "neutral" | "info";
  subLabel: string | null;
  subTone: "success" | "warning" | "danger" | "neutral" | "info";
  tooltip: string;
} {
  switch (origin) {
    case "hive_registered":
      return {
        typeLabel: "Hive 注册",
        typeTone: "success",
        subLabel: null,
        subTone: "neutral",
        tooltip: "由 Hive 通过 codex-tool 自动注册（SkyMail 拿邮箱 + 接码 + ChatGPT OAuth），凭据齐全可自动维护。"
      };
    case "adopted_active":
      return {
        typeLabel: "远端发现",
        typeTone: "info",
        subLabel: "凭据齐",
        subTone: "success",
        tooltip:
          "在 Sub2API 远端列表里发现的存量账号，带 refresh_token 等凭据可自动刷新。Hive 不会去碰它的密码，仅做健康观察 + 配额采样。"
      };
    case "adopted_recovered":
      // 注意：此 origin 表示"远端发现 + 本地已持有手机号/密码凭据"，可能来自两种途径：
      //   ① codex_login 登录成功后回写；② 接管时从 codex-tool 导出补全凭据（尚未登录）。
      // 所以这里**不能**断言"已恢复可用" —— 账号当前是否可用以「健康」列为准
      // （revoked 的账号补了凭据后仍是掉线，等 codex_login 真正登录成功才转健康）。
      return {
        typeLabel: "远端发现",
        typeTone: "info",
        subLabel: "凭据齐",
        subTone: "info",
        tooltip:
          "Sub2API 发现的账号，本地已补全手机号 + 密码凭据，可由 Hive 自动登录维护。当前是否可用以「健康」列为准：掉线状态会在下次巡检尝试 codex_login 修复。"
      };
    case "adopted_observing":
      return {
        typeLabel: "远端发现",
        typeTone: "info",
        subLabel: "凭据缺",
        subTone: "warning",
        tooltip:
          "在 Sub2API 远端发现，但没有 refresh_token 等可自动恢复的凭据，Hive 无法自动修复。需要远端补凭据或本地建新账号顶替。"
      };
    case "retired_legacy":
      return {
        typeLabel: "已弃用",
        typeTone: "neutral",
        subLabel: null,
        subTone: "neutral",
        tooltip: "本地账号在远端列表里已消失（手动删除/迁移），保留只做审计留痕，不参与调度。"
      };
  }
}

/**
 * P6-13 状态徽标 —— 区分"修复中"(正在跑 job)与"等待重试"(recovering 但在退避窗口、
 * 下次尝试在未来、当前没有活跃 job)。解决"修复中却没有进行中 job"的困惑。
 */
function RecoverStatus(props: { acc: AccountRecordView }) {
  const acc = props.acc;
  if (acc.intent === "recovering" && acc.nextRecoveryAfter) {
    const next = new Date(acc.nextRecoveryAfter).getTime();
    if (Number.isFinite(next) && next > Date.now()) {
      const hh = new Date(acc.nextRecoveryAfter).toLocaleTimeString();
      const lines = [
        `修复退避中：下次尝试 ${hh}`,
        `已尝试 ${acc.recoveryAttempts} 次 —— 多次失败后按退避序列拉长间隔，期间不占用修复槽位`
      ];
      if (acc.lastRecoveryError) lines.push(`上次报错：${acc.lastRecoveryError}`);
      return (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
          <Badge tone="warning">等待重试</Badge>
          <InfoTip text={lines.join("\n")} />
        </span>
      );
    }
  }
  return <IntentBadge intent={acc.intent} />;
}

function IntentBadge(props: { intent: AccountIntent }) {
  const label: Record<AccountIntent, string> = {
    pending: "待落地",
    active: "活跃",
    recovering: "修复中",
    retired: "已退役"
  };
  const tone: Record<AccountIntent, "success" | "warning" | "danger" | "neutral" | "info"> = {
    pending: "warning",
    active: "success",
    recovering: "info",
    retired: "neutral"
  };
  return <Badge tone={tone[props.intent]}>{label[props.intent]}</Badge>;
}

const HEALTH_LABEL: Record<AccountHealth, string> = {
  healthy: "健康",
  rate_limited: "限流",
  quota_exhausted: "配额耗尽",
  broken: "掉线",
  unknown: "未知"
};
const HEALTH_TONE: Record<AccountHealth, "success" | "warning" | "danger" | "neutral" | "info"> = {
  healthy: "success",
  rate_limited: "warning",
  quota_exhausted: "warning",
  broken: "danger",
  unknown: "neutral"
};

function HealthBadge(props: { health: AccountHealth }) {
  return <Badge tone={HEALTH_TONE[props.health]}>{HEALTH_LABEL[props.health]}</Badge>;
}

/**
 * 出口节点列 tooltip —— 把多源数据拼成一句话解释，让用户知道这个节点名是哪来的、
 * 旁边的灰字"上次出口 xxx"是怎么回事。
 */
function formatRecoveryPathLabel(path: AccountRecordView["lastRecoveryPath"]): string {
  if (path === "codex_login") return "登录续命（邮箱 OTP）";
  if (path === "codex_register") return "重新注册（接码）";
  return String(path);
}

function formatEgressTooltip(acc: AccountRecordView): string {
  const lines: string[] = [];
  if (acc.currentNodeName) {
    lines.push(`当前出口：Sub2API 把此账号绑在「${acc.currentNodeName}」`);
    if (acc.currentProxyId) lines.push(`远端代理 ID：#${acc.currentProxyId}`);
  } else if (acc.currentProxyId) {
    lines.push(`当前出口：Sub2API 远端代理 #${acc.currentProxyId}（本地节点表里查不到）`);
    lines.push("可能是手动建的外部代理 / 节点已删 / 尚未推送");
  } else {
    lines.push("当前出口：Sub2API 未给此账号绑代理");
  }
  if (acc.egressNodeHash) {
    lines.push("");
    lines.push(`上次注册/登录出口节点：${acc.egressNodeHash.slice(0, 8)}…`);
  }
  // P5-AI: 短信注册数据
  if (acc.smsCountry || acc.smsCostCents != null) {
    lines.push("");
    const parts: string[] = [];
    if (acc.smsCountry) parts.push(`地区 ${acc.smsCountry}`);
    if (acc.smsCostCents != null) parts.push(`成本 $${(acc.smsCostCents / 100).toFixed(2)}`);
    lines.push(`注册短信：${parts.join(" · ")}`);
  }
  if (acc.lastRecoveryPath || acc.lastRecoveryFailureCategory || acc.lastRecoveryError) lines.push("");
  if (acc.lastRecoveryPath) lines.push(`最近修复方式：${formatRecoveryPathLabel(acc.lastRecoveryPath)}`);
  // P5-AI: codex-tool 失败分类（external-integration.md §"OAuth 失败分类"）
  if (acc.lastRecoveryFailureCategory) {
    lines.push(`失败类型：${formatFailureCategory(acc.lastRecoveryFailureCategory)}`);
  }
  if (acc.lastRecoveryError) lines.push(`上次修复报错：${acc.lastRecoveryError}`);
  return lines.join("\n");
}

/**
 * P5-AU: Sub2API "限流中" 冷却恢复时间。配额耗尽时 Sub2API 给账号设冷却截止
 * (temp_unschedulable_until) / 配额重置预计时间 (rate_limit_reset_at)。
 * 返回剩余时长标签（>24h 显示 "Xd Yh"，否则 "Xh Ym" / "Ym"），过期/无则 null。
 */
function recoveryRemainingLabel(acc: AccountRecordView): string | null {
  const until = acc.tempUnschedulableUntil ?? acc.rateLimitResetAt ?? null;
  if (!until) return null;
  const ms = new Date(until).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const totalMin = Math.round(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days >= 1) return `${days}d${hours}h`; // 超过 24h → 几d几h
  if (hours >= 1) return `${hours}h${mins}m`;
  return `${mins}m`;
}

function recoveryTooltip(acc: AccountRecordView): string {
  const until = acc.tempUnschedulableUntil ?? acc.rateLimitResetAt ?? null;
  const lines = [`配额冷却中：预计 ${until ? new Date(until).toLocaleString() : "未知"} 自然恢复`];
  if (acc.tempUnschedulableReason) lines.push(`原因：${acc.tempUnschedulableReason}`);
  lines.push("");
  lines.push("账号会自动恢复，无需在冷却期内手动触发。");
  return lines.join("\n");
}

function formatFailureCategory(c: NonNullable<AccountRecordView["lastRecoveryFailureCategory"]>): string {
  switch (c) {
    case "account_unusable":
      return "账号已停用（OpenAI 确认删除/停用，已退役）";
    case "network_or_proxy":
      return "出口/网络/consent 类（账号活着，不退役，换干净出口可救）";
    case "oauth_failed":
      return "普通 OAuth 失败（重试中）";
  }
}

/**
 * P5-AQ 账号质量列。把"存活天数 + 历史重登次数"压成一个单元格，
 * 配 InfoTip 给出首见时间 / 重登次数 / 最近修复时间的完整解读。
 * 存活越久、重登越少 → 账号越稳，是判断质量的核心直观指标。
 */
function formatDaysAlive(acc: AccountRecordView): string {
  if (!acc.firstSeenAt) return "—";
  const start = new Date(acc.firstSeenAt).getTime();
  // 掉线账号：存活时间冻结在首次掉线时刻(brokenSinceTick)，不再随时间虚涨；
  // healthy/限流/配额冷却等仍按"到现在"算（它们还活着/会自然恢复）。
  const end = aliveFrozenAtMs(acc) ?? Date.now();
  const ms = end - start;
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h`;
  const mins = Math.floor(ms / 60_000);
  return mins >= 1 ? `${mins}m` : "<1m";
}

/** 掉线账号的存活冻结时刻（ms）；非掉线 / 无掉线戳 → null（按"到现在"算）。 */
function aliveFrozenAtMs(acc: AccountRecordView): number | null {
  if (acc.health !== "broken" || !acc.brokenSinceTick) return null;
  const ms = new Date(acc.brokenSinceTick).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function formatQualityTooltip(acc: AccountRecordView): string {
  const lines: string[] = [];
  lines.push(acc.firstSeenAt ? `首见时间：${new Date(acc.firstSeenAt).toLocaleString()}` : "首见时间：未知");
  lines.push(`累计重新登录：${acc.reloginCount} 次`);
  const frozen = aliveFrozenAtMs(acc);
  if (frozen !== null) {
    lines.push(`存活时间已冻结（掉线于 ${new Date(frozen).toLocaleString()}），不再随时间累加`);
  }
  if (acc.lastRecoveredAt) {
    lines.push(`最近修复成功：${new Date(acc.lastRecoveredAt).toLocaleString()}`);
  }
  if (acc.recoveryAttempts > 0) {
    lines.push(`当前连续修复尝试：${acc.recoveryAttempts} 次（成功即清零）`);
  }
  return lines.join("\n");
}

function quotaToneClass(percent: number | null): string {
  if (percent === null) return "muted";
  if (percent >= 95) return "text-danger";
  if (percent >= 80) return "text-warning";
  return "";
}

function rowRoleByHealth(health: AccountHealth): "serving" | "quarantined" | "evicted" | "standby" | "paused" {
  // 复用现有 .node-matrix-table tr.role-XXX 颜色：broken → danger 行底，rate/quota → warning 底
  switch (health) {
    case "broken":
      return "evicted";
    case "rate_limited":
    case "quota_exhausted":
      return "quarantined";
    case "unknown":
      return "standby";
    case "healthy":
    default:
      return "serving";
  }
}

/** P6-10 账号矩阵活动优先级：数字越小越靠前。已退役死号沉底。 */
function matrixActivityRank(a: AccountRecordView): number {
  if (a.intent === "retired") return 6; // 死号永远沉底
  if (a.intent === "recovering") return 0; // 正在修复，最该看
  if (a.intent === "pending") return 1; // 注册落地中
  if (a.health === "broken") return 2; // 可恢复掉线
  if (a.health === "rate_limited") return 3;
  if (a.health === "healthy") return 4;
  if (a.health === "quota_exhausted") return 5; // 冷却中，自己会好
  return 5;
}

/** 同档内的"最近有变动"信号：取变更历史头条 + 恢复/注册/限流等真实事件时间最大值（非 updatedAt）。 */
function matrixRecencyMs(a: AccountRecordView): number {
  const ts = [a.lastRecoveredAt, a.registeredAt, a.rateLimitedAt, a.firstSeenAt]
    .filter((t): t is string => Boolean(t))
    .map((t) => new Date(t).getTime())
    .filter((n) => Number.isFinite(n));
  return Math.max(matrixChangeMs(a), ts.length ? Math.max(...ts) : 0);
}

/** change_history 头条（最新一次真实变动）的时间戳 ms；无历史 → 0。 */
function matrixChangeMs(a: AccountRecordView): number {
  const head = a.changeHistory?.[0];
  if (!head) return 0;
  const ms = new Date(head.at).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

const CHANGE_INTENT_LABEL: Record<AccountIntent, string> = {
  pending: "待落地",
  active: "活跃",
  recovering: "修复中",
  retired: "已退役"
};

/** 把一条变更记录格式化成紧凑文案，如「额度5h 0→80%」「掉线→健康」「活跃→已退役」。 */
function formatChangeEntry(e: AccountChangeEntry): string {
  if (e.kind === "health") return `${HEALTH_LABEL[e.from]}→${HEALTH_LABEL[e.to]}`;
  if (e.kind === "intent") return `${CHANGE_INTENT_LABEL[e.from]}→${CHANGE_INTENT_LABEL[e.to]}`;
  const pct = (n: number | null) => (n === null ? "—" : `${n}%`);
  const parts: string[] = [];
  if (e.q5From !== e.q5To) parts.push(`5h ${pct(e.q5From)}→${pct(e.q5To)}`);
  if (e.q7From !== e.q7To) parts.push(`7d ${pct(e.q7From)}→${pct(e.q7To)}`);
  return `额度 ${parts.join(" · ") || "无变化"}`;
}

/**
 * 变更列的紧凑标记：只显示"变成了什么"（结果状态）+ 颜色，完整 from→to 留在悬浮里。
 *   - health：目标健康档（掉线红 / 健康绿 / 限流·配额黄 / 未知灰）
 *   - intent：目标意图（退役灰 / 活跃绿 / 修复中蓝 / 待落地黄）
 *   - quota：方向箭头（↑消耗 / ↓释放），消耗到高位才标黄，否则灰（额度变动只是信息）
 */
function changeBrief(e: AccountChangeEntry): { text: string; cls: string } {
  if (e.kind === "health") {
    const cls =
      e.to === "broken"
        ? "text-danger"
        : e.to === "healthy"
          ? "text-success"
          : e.to === "unknown"
            ? "muted"
            : "text-warning";
    return { text: HEALTH_LABEL[e.to], cls };
  }
  if (e.kind === "intent") {
    const cls =
      e.to === "retired"
        ? "muted"
        : e.to === "active"
          ? "text-success"
          : e.to === "recovering"
            ? "text-info"
            : "text-warning";
    return { text: CHANGE_INTENT_LABEL[e.to], cls };
  }
  const up = (e.q5To ?? 0) + (e.q7To ?? 0) >= (e.q5From ?? 0) + (e.q7From ?? 0);
  const high = (e.q5To ?? 0) >= 80 || (e.q7To ?? 0) >= 80;
  return { text: `配额${up ? "↑" : "↓"}`, cls: up && high ? "text-warning" : "muted" };
}

/** 相对时间的极简中文（用于变更列）：刚刚 / N分钟前 / N小时前 / N天前。 */
function shortAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  return `${Math.floor(hr / 24)}天前`;
}

/** 变更历史的多行 tooltip（最近 N 条，每行「相对时间  文案」）。 */
function changeHistoryTooltip(a: AccountRecordView): string {
  const hist = a.changeHistory ?? [];
  if (hist.length === 0) return "暂无记录的变动";
  return hist.map((e) => `${shortAgo(e.at)}  ${formatChangeEntry(e)}`).join("\n");
}

function SkippedIcon(props: { skipped: AccountFleetTickSummary["skippedReason"] }) {
  switch (props.skipped) {
    case "applied":
      return <CheckCircle2 size={14} aria-hidden="true" />;
    case "no_change":
      return <ShieldCheck size={14} aria-hidden="true" />;
    case "paused":
      return <Clock size={14} aria-hidden="true" />;
    case "batch_capped":
    case "budget_exhausted":
      return <Activity size={14} aria-hidden="true" />;
    case "error":
      return <AlertOctagon size={14} aria-hidden="true" />;
    default:
      return <Loader2 size={14} aria-hidden="true" />;
  }
}

function SkippedBadge(props: { skipped: AccountFleetTickSummary["skippedReason"] }) {
  const tone =
    props.skipped === "applied" || props.skipped === "no_change"
      ? "success"
      : props.skipped === "error"
        ? "danger"
        : props.skipped === "paused" || props.skipped === "budget_exhausted" || props.skipped === "batch_capped"
          ? "warning"
          : "info";
  return <Badge tone={tone}>{formatSkipReason(props.skipped)}</Badge>;
}

function formatSkipReason(reason: AccountFleetTickSummary["skippedReason"]): string {
  switch (reason) {
    case "applied":
      return "已入队";
    case "no_change":
      return "无变更";
    case "paused":
      return "未开启";
    case "batch_capped":
      return "灰度受限";
    case "budget_exhausted":
      return "预算耗尽";
    case "error":
      return "错误";
    default:
      return reason;
  }
}

function summarizeTick(tick: AccountFleetTickSummary): string {
  if (tick.skippedReason === "error") return tick.errorMessage ?? "巡检异常";
  if (tick.skippedReason === "no_change") return "状态符合预期，无需变更";
  if (tick.skippedReason === "paused") {
    return `自动维护已暂停（计划 ${tick.plannedTotal} 项）`;
  }
  if (tick.skippedReason === "budget_exhausted") {
    return `预算耗尽：计划 ${tick.plannedTotal} 项，入队 0`;
  }
  if (tick.skippedReason === "batch_capped") {
    return `灰度受限：计划 ${tick.plannedTotal} 项，入队 ${tick.appliedTotal}`;
  }
  return `入队 ${tick.appliedTotal} / 计划 ${tick.plannedTotal} 项`;
}

function jobReason(status: AccountJob["status"]): string {
  switch (status) {
    case "succeeded":
      return "no_change"; // 借用 success 配色（绿色 row）
    case "failed":
      return "error";
    case "running":
      return "paused"; // 借用 info 灰
    case "queued":
      return "paused";
    case "cancelled":
      return "no_change";
  }
}

function JobStatusIcon(props: { status: AccountJob["status"] }) {
  switch (props.status) {
    case "succeeded":
      return <CheckCircle2 size={14} aria-hidden="true" />;
    case "failed":
      return <XCircle size={14} aria-hidden="true" />;
    case "running":
      return <Loader2 size={14} className="animate-spin" aria-hidden="true" />;
    case "queued":
      return <Clock size={14} aria-hidden="true" />;
    case "cancelled":
      return <AlertOctagon size={14} aria-hidden="true" />;
  }
}

function jobBadgeTone(status: AccountJob["status"]): "success" | "warning" | "danger" | "neutral" | "info" {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
      return "danger";
    case "running":
      return "info";
    case "queued":
      return "warning";
    case "cancelled":
      return "neutral";
  }
}

function jobStatusLabel(status: AccountJob["status"]): string {
  return {
    succeeded: "成功",
    failed: "失败",
    running: "运行中",
    queued: "排队",
    cancelled: "已取消"
  }[status];
}

function jobKindLabel(kind: AccountJob["kind"]): string {
  return {
    codex_login: "codex_login（修复）",
    codex_register: "codex_register（注册）",
    import_to_sub2api: "导入 refresh_token",
    import_codex_tool_account: "接管 codex-tool 账号",
    delete_sub2api: "删 Sub2API 账号",
    toggle_schedulable: "切 schedulable",
    observe_usage: "查配额"
  }[kind];
}
