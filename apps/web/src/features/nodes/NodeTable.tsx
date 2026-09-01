import React from "react";
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState
} from "@tanstack/react-table";
import {
  AlertTriangle,
  ArrowDownUp,
  Bot,
  Check,
  CheckCircle2,
  CircleDot,
  GitBranch,
  MessageSquare,
  MinusCircle,
  Search,
  Star,
  Users,
  XCircle
} from "lucide-react";
import type { ProxyNode, Sub2ApiProxyRecord } from "@mihomo-hive/schemas";
import { Badge, Checkbox, EmptyState, Pager, SelectInput, TextInput } from "../../components/ui.js";
import {
  formatLifecycleStatus,
  formatRegion,
  formatNodeStatus,
  lifecycleTone,
  type NodeFilters,
  statusTone,
  uniqueOptions
} from "./node-utils.js";

export function NodeTable(props: {
  nodes: ProxyNode[];
  filteredNodes: ProxyNode[];
  filters: NodeFilters;
  sourceNames: Map<string, string>;
  selectedHashes: Set<string>;
  /** key = proxy_id；用于显示 Sub2API 端的状态和账号数；未连接 / 未推送时传 undefined */
  sub2apiProxies?: Map<number, Sub2ApiProxyRecord>;
  /** Sub2API 连接是否已配置；用于"未推送"列文案 */
  sub2apiConnected: boolean;
  onFiltersChange: (filters: NodeFilters) => void;
  onToggleNode: (hash: string, selected: boolean) => void;
}) {
  const [sorting, setSorting] = React.useState<SortingState>([{ id: "assignedPort", desc: false }]);
  const columns = React.useMemo<ColumnDef<ProxyNode>[]>(
    () => [
      {
        id: "select",
        header: "",
        cell: ({ row }) => {
          const node = row.original;
          return (
            <Checkbox
              checked={props.selectedHashes.has(node.hash)}
              onChange={(checked) => props.onToggleNode(node.hash, checked)}
            />
          );
        },
        enableSorting: false,
        size: 42
      },
      {
        accessorKey: "assignedPort",
        header: "端口",
        cell: ({ row }) => <span className="mono-strong">{row.original.assignedPort ?? "-"}</span>,
        sortingFn: "alphanumeric",
        size: 76
      },
      {
        accessorKey: "name",
        header: "节点名称",
        cell: ({ row }) => (
          <span className="node-name" title={row.original.name} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {row.original.kind === "chain" ? <GitBranch size={13} className="text-info" aria-label="链式节点" /> : null}
            {row.original.codexReserved ? (
              <Star size={13} className="text-warning" fill="currentColor" aria-label="保留节点" />
            ) : null}
            {row.original.name}
          </span>
        ),
        size: 300
      },
      {
        accessorKey: "lifecycleStatus",
        header: "调度",
        cell: ({ row }) => <Badge tone={lifecycleTone(row.original.lifecycleStatus)}>{formatLifecycleStatus(row.original.lifecycleStatus)}</Badge>,
        size: 92
      },
      {
        accessorKey: "status",
        header: "状态",
        cell: ({ row }) => <Badge tone={statusTone(row.original.status)}>{formatNodeStatus(row.original.status)}</Badge>,
        size: 86
      },
      {
        accessorKey: "region",
        header: "地区",
        cell: ({ row }) => formatRegion(row.original.region),
        size: 82
      },
      {
        accessorKey: "type",
        header: "协议",
        cell: ({ row }) => <span className="mono">{row.original.type}</span>,
        size: 78
      },
      {
        accessorKey: "lastTestLatencyMs",
        header: "代理延迟",
        cell: ({ row }) => <ProxyLatencyCell ms={row.original.lastTestLatencyMs ?? null} />,
        size: 92
      },
      {
        accessorKey: "qualityScore",
        header: "质量",
        cell: ({ row }) => <QualityCell score={row.original.qualityScore ?? null} />,
        size: 80
      },
      {
        id: "codexOutcome",
        header: "登录实测",
        cell: ({ row }) => <CodexOutcomeCell node={row.original} />,
        size: 96
      },
      {
        accessorKey: "lastTestStatus",
        header: "目标延迟",
        cell: ({ row }) => (
          <TargetLatencies
            targetsJson={row.original.lastTestTargets}
            fallbackStatus={row.original.lastTestStatus}
          />
        ),
        size: 230
      },
      {
        id: "sub2api",
        header: "Sub2API",
        cell: ({ row }) => (
          <Sub2ApiCell
            node={row.original}
            proxy={row.original.sub2apiProxyId ? props.sub2apiProxies?.get(row.original.sub2apiProxyId) : undefined}
            connected={props.sub2apiConnected}
          />
        ),
        enableSorting: false,
        size: 108
      },
      {
        id: "accountCount",
        header: "账号",
        accessorFn: (node) =>
          node.sub2apiProxyId ? props.sub2apiProxies?.get(node.sub2apiProxyId)?.account_count ?? 0 : -1,
        cell: ({ row }) => (
          <AccountCountCell
            proxy={row.original.sub2apiProxyId ? props.sub2apiProxies?.get(row.original.sub2apiProxyId) : undefined}
            hasProxyId={Boolean(row.original.sub2apiProxyId)}
          />
        ),
        sortingFn: "alphanumeric",
        size: 76
      },
      {
        accessorKey: "sourceId",
        header: "来源",
        cell: ({ row }) => <span className="truncate-cell">{props.sourceNames.get(row.original.sourceId) ?? row.original.sourceId}</span>,
        size: 140
      }
    ],
    [props]
  );
  const table = useReactTable({
    data: props.filteredNodes,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: { pageSize: 50 }
    }
  });

  return (
    <section className="nodes-workspace">
      <header className="nodes-toolbar">
        <div className="search-box">
          <Search size={16} />
          <TextInput
            value={props.filters.search}
            onChange={(search) => props.onFiltersChange({ ...props.filters, search })}
            placeholder="搜索节点、地区、协议"
          />
        </div>
        <SelectInput
          value={props.filters.status}
          onChange={(status) => props.onFiltersChange({ ...props.filters, status })}
          options={[
            { label: "全部状态", value: "all" },
            { label: "可用", value: "active" },
            { label: "失败", value: "failed" },
            { label: "未测试", value: "untested" },
            { label: "停用", value: "inactive" }
          ]}
        />
        <SelectInput
          value={props.filters.region}
          onChange={(region) => props.onFiltersChange({ ...props.filters, region })}
          options={[{ label: "全部地区", value: "all" }, ...uniqueOptions(props.nodes, "region")]}
        />
        <SelectInput
          value={props.filters.type}
          onChange={(type) => props.onFiltersChange({ ...props.filters, type })}
          options={[{ label: "全部协议", value: "all" }, ...uniqueOptions(props.nodes, "type")]}
        />
        <SelectInput
          value={props.filters.sourceId}
          onChange={(sourceId) => props.onFiltersChange({ ...props.filters, sourceId })}
          options={[
            { label: "全部来源", value: "all" },
            ...uniqueOptions(props.nodes, "sourceId").map((o) => ({
              label: props.sourceNames.get(o.value) ?? o.value,
              value: o.value
            }))
          ]}
        />
        <TextInput
          value={props.filters.portFrom}
          onChange={(portFrom) => props.onFiltersChange({ ...props.filters, portFrom })}
          placeholder="端口从"
          mono
        />
        <TextInput
          value={props.filters.portTo}
          onChange={(portTo) => props.onFiltersChange({ ...props.filters, portTo })}
          placeholder="端口到"
          mono
        />
      </header>

      <div className="table-frame">
        {props.filteredNodes.length === 0 ? (
          <EmptyState branded title="没有匹配的节点" description="调整筛选条件，或先完成订阅拉取和节点导入。" />
        ) : (
          <table className="node-table">
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th key={header.id} style={{ width: header.getSize() }}>
                      {header.isPlaceholder ? null : (
                        <button
                          className={header.column.getCanSort() ? "sortable-header" : "plain-header"}
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {header.column.getCanSort() ? <ArrowDownUp size={13} /> : null}
                        </button>
                      )}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr key={row.original.hash} className={props.selectedHashes.has(row.original.hash) ? "is-selected" : ""}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <footer className="table-footer">
        <Pager
          page={table.getState().pagination.pageIndex}
          pageCount={Math.max(1, table.getPageCount())}
          total={props.filteredNodes.length}
          pageSize={table.getState().pagination.pageSize}
          onPageChange={(p) => table.setPageIndex(p)}
          onPageSizeChange={(s) => table.setPageSize(s)}
        />
      </footer>
    </section>
  );
}

function QualityCell(props: { score: number | null | undefined }) {
  if (props.score === null || props.score === undefined) {
    return <span className="muted small">-</span>;
  }
  const tone: "success" | "warning" | "danger" = props.score >= 80 ? "success" : props.score >= 50 ? "warning" : "danger";
  return <Badge tone={tone}>{props.score}</Badge>;
}

/**
 * codex_login 实战战绩（P5-AS）：经此节点出口真实登录/注册的 成功 / 失败 次数。
 * 区别于"质量"（openai 连通性测试）—— 这一列反映"能否过 Cloudflare Sentinel"。
 * 成功>0 绿、纯失败红、没跑过灰。
 */
function CodexOutcomeCell(props: { node: ProxyNode }) {
  const ok = props.node.codexLoginSuccess ?? 0;
  const fail = props.node.codexLoginFailure ?? 0;
  if (ok === 0 && fail === 0) return <span className="muted" title="尚未经此节点跑过登录/注册">-</span>;
  const tone: "success" | "warning" | "danger" = ok > 0 ? "success" : "danger";
  return (
    <Badge tone={tone}>
      {ok}✓ / {fail}✗
    </Badge>
  );
}

/**
 * 代理延迟（L1）：服务直连代理 host:port 的 TCP 握手延迟。
 * 不经 mihomo、不经业务目标 — 反映"我方→代理"的网络距离。
 * 加入前置代理（dialer-proxy）后将变为"服务→front→代理"链路握手延迟。
 *
 * 阈值（经验）：<200ms 绿、<800ms 中性、<2000ms 黄、≥2000ms 红、null 灰。
 */
function ProxyLatencyCell(props: { ms: number | null }) {
  if (props.ms === null || props.ms === undefined) return <span className="muted small">-</span>;
  const ms = props.ms;
  const tone: "success" | "neutral" | "warning" | "danger" =
    ms < 200 ? "success" : ms < 800 ? "neutral" : ms < 2000 ? "warning" : "danger";
  const display = ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
  return <Badge tone={tone}>{display}</Badge>;
}

interface TargetResultEntry {
  targetId: string;
  ok: boolean;
  latencyMs: number;
  httpStatus?: number;
  message?: string;
}

function parseTargetResults(json: string | undefined): TargetResultEntry[] {
  if (!json) return [];
  try {
    const data = JSON.parse(json);
    if (!Array.isArray(data)) return [];
    return data
      .filter((item): item is { targetId: string; ok: boolean; latencyMs: number } & Record<string, unknown> =>
        Boolean(item) && typeof item.targetId === "string" && typeof item.ok === "boolean" && typeof item.latencyMs === "number"
      )
      .map((item) => ({
        targetId: item.targetId,
        ok: item.ok,
        latencyMs: item.latencyMs,
        ...(typeof item.httpStatus === "number" ? { httpStatus: item.httpStatus } : {}),
        ...(typeof item.message === "string" ? { message: item.message } : {})
      }));
  } catch {
    return [];
  }
}

/**
 * 目标延迟（L2）：通过 mihomo listener 到 OpenAI / Claude 等业务目标的端到端延迟。
 * 用秒.cc 显示，颜色按延迟健康度（<1.5s 绿、<3s 黄、≥3s 暖橙）。
 * 失败用错误色 + Fail 字串保留信号；优先读 lastTestTargets，fallback 到旧 lastTestStatus。
 */
function TargetLatencies(props: { targetsJson: string | undefined; fallbackStatus: string | undefined }) {
  const targets = parseTargetResults(props.targetsJson);
  if (targets.length === 0) {
    // 旧数据兜底（没有 latency 信息，只能显示 OK/Fail）
    const fallback = props.fallbackStatus
      ? props.fallbackStatus.split(",").map((item) => {
          const [target = "?", detail = "-"] = item.split(":");
          const ok = target === "openai" ? detail === "401" : target === "claude" ? detail === "405" : false;
          return { targetId: target, ok, latencyMs: 0, message: detail };
        })
      : [];
    if (fallback.length === 0) return <span className="muted small">-</span>;
    return (
      <div className="test-result-list">
        {fallback.map((r) => (
          <span key={r.targetId} className={`test-chip ${r.ok ? "is-ok" : "is-fail"}`}>
            {targetIcon(r.targetId)}
            <span>{targetLabel(r.targetId)}</span>
            <strong>{r.ok ? "OK" : "Fail"}</strong>
          </span>
        ))}
      </div>
    );
  }
  return (
    <div className="test-result-list">
      {targets.map((r) => {
        const seconds = r.latencyMs / 1000;
        const display = `${seconds.toFixed(2)}s`;
        const cls = r.ok ? targetLatencyToneClass(r.latencyMs) : "is-fail";
        const tooltip = r.ok
          ? `${targetLabel(r.targetId)}: ${display}${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ""}`
          : `${targetLabel(r.targetId)} 失败: ${r.message ?? "未知"}（${display}）`;
        return (
          <span key={r.targetId} className={`test-chip ${cls}`} title={tooltip}>
            {targetIcon(r.targetId)}
            <span>{targetLabel(r.targetId)}</span>
            <strong>{r.ok ? display : "Fail"}</strong>
          </span>
        );
      })}
    </div>
  );
}

function targetLatencyToneClass(ms: number): string {
  if (ms < 1500) return "is-ok";       // 绿
  if (ms < 3000) return "is-warn";     // 黄
  return "is-slow";                    // 橙红（通但很慢）
}

function targetIcon(targetId: string) {
  if (targetId === "openai") return <Bot size={13} />;
  if (targetId === "claude") return <MessageSquare size={13} />;
  return null;
}

function targetLabel(targetId: string): string {
  if (targetId === "openai") return "OpenAI";
  if (targetId === "claude") return "Claude";
  return targetId;
}

function Sub2ApiCell(props: { node: ProxyNode; proxy: Sub2ApiProxyRecord | undefined; connected: boolean }) {
  if (!props.connected) {
    return (
      <span className="sub2api-cell muted" title="Sub2API 连接未配置；在设置与工具页配置后此处会显示远端状态。">
        <MinusCircle size={14} aria-hidden="true" />
        <span className="small">未连接</span>
      </span>
    );
  }
  if (!props.node.sub2apiProxyId) {
    return (
      <span
        className="sub2api-cell muted"
        title="尚未推送到 Sub2API。在节点池工具栏选中后点'启用调度'会自动推送。"
      >
        <CircleDot size={14} aria-hidden="true" />
        <span className="small">未推送</span>
      </span>
    );
  }
  if (!props.proxy) {
    return (
      <span
        className="sub2api-cell sub2api-cell-warning"
        title="本地记录了 proxy_id，但 Sub2API 当前列表里找不到对应代理。可能被外部删除，需要重新启用调度。"
      >
        <AlertTriangle size={14} aria-hidden="true" />
        <span className="mono small">#{props.node.sub2apiProxyId}</span>
        <span className="small">失联</span>
      </span>
    );
  }
  const status = props.proxy.status;
  const StatusIcon = status === "active" ? CheckCircle2 : status === "failed" ? XCircle : MinusCircle;
  const tone = status === "active" ? "sub2api-cell-ok" : status === "failed" ? "sub2api-cell-bad" : "sub2api-cell-idle";
  return (
    <span
      className={`sub2api-cell ${tone}`}
      title={`Sub2API #${props.proxy.id} ${props.proxy.protocol}://${props.proxy.host}:${props.proxy.port}\n状态: ${status}`}
    >
      <StatusIcon size={14} aria-hidden="true" />
      <span className="mono small">#{props.proxy.id}</span>
    </span>
  );
}

function AccountCountCell(props: { proxy: Sub2ApiProxyRecord | undefined; hasProxyId: boolean }) {
  if (!props.hasProxyId) {
    return <span className="muted small">-</span>;
  }
  if (!props.proxy) {
    return <span className="muted small">?</span>;
  }
  const count = props.proxy.account_count ?? 0;
  const tone = count > 0 ? "info" : "neutral";
  return (
    <Badge tone={tone}>
      <span className="badge-icon-text" title={`当前 Sub2API 端绑定到此代理的账号数：${count}`}>
        <Users size={11} aria-hidden="true" />
        {count}
      </span>
    </Badge>
  );
}
