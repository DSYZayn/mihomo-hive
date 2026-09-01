import { Activity, Upload } from "lucide-react";
import type {
  Sub2ApiExportPreview,
  Sub2ApiSafeConnectionConfig
} from "@mihomo-hive/schemas";
import {
  Sub2ApiConnectionPanel,
  type Sub2ApiConnectionDraft
} from "../features/system/Sub2ApiConnectionPanel.js";
import { ExportPanel } from "../features/export/ExportPanel.js";
import { Badge, Button, CollapsiblePanel, Panel } from "../components/ui.js";
import type { ConfirmAction } from "../hooks/useConfirmAction.js";

interface PendingMutation {
  isPending: boolean;
}

/**
 * 设置与工具页：连接配置、节点验活/幂等推送和导出。
 */
export interface SystemRouteProps {
  // Sub2API 连接
  sub2apiConnection: Sub2ApiSafeConnectionConfig | undefined;
  sub2apiConnectionDraft: Sub2ApiConnectionDraft;
  setSub2apiConnectionDraft: (next: Sub2ApiConnectionDraft) => void;
  // Sub2API 运维工具
  managedProxyCount: number;
  // 导出节点
  exportHost: string;
  exportFilename: string;
  failedNodeStatus: "active" | "inactive";
  selectedCount: number;
  exportableSelectedCount: number;
  selectedHashesList: string[];
  exportPreview: Sub2ApiExportPreview | undefined;
  exportPreviewFetching: boolean;
  downloading: boolean;
  setExportHost: (v: string) => void;
  setExportFilename: (v: string) => void;
  setFailedNodeStatus: (v: "active" | "inactive") => void;
  onDownload: () => void;
  requestConfirmation: (action: ConfirmAction) => void;
  // mutations
  mutations: {
    saveSub2apiConnection: PendingMutation & {
      mutate: (input: {
        baseUrl: string;
        adminApiKey?: string | undefined;
        timezone: string;
        managedProxyPrefix: string;
      }) => void;
    };
    testSub2apiConnection: PendingMutation & {
      mutate: (input?: { baseUrl?: string | undefined; adminApiKey?: string | undefined }) => void;
    };
    pushLocalNodes: PendingMutation & { mutate: () => void };
    qualityCheck: PendingMutation & { mutate: () => void };
    writeExport: PendingMutation & {
      mutate: (input: {
        selectedHashes: string[];
        host: string;
        filename: string;
        failedNodeStatus: "active" | "inactive";
      }) => void;
    };
  };
}

export function SystemRoute(props: SystemRouteProps) {
  const m = props.mutations;
  const sub2apiConnected = Boolean(props.sub2apiConnection?.configured);

  return (
    <section className="workspace-grid system-workspace">
      {/* 顶部状态条：一眼看出连接状态 + 引导首次用户从哪开始（全宽,不进三列网格） */}
      <div className="system-statusbar">
        <StatusChip
          label="Sub2API"
          ok={sub2apiConnected}
          okText="已连接"
          pendingText="未连接 · 先在下方配置"
        />
        <span className="system-statusbar-hint muted small">系统只维护节点出口，不会自动更换账号代理。</span>
      </div>

      <div className="system-stack">
        {/* Col 1: Sub2API 主题（连接 + 运维工具） */}
        <div className="system-col">
          <Sub2ApiConnectionPanel
            connection={props.sub2apiConnection}
            draft={props.sub2apiConnectionDraft}
            saving={m.saveSub2apiConnection.isPending}
            testing={m.testSub2apiConnection.isPending}
            onDraftChange={props.setSub2apiConnectionDraft}
            onSave={() =>
              m.saveSub2apiConnection.mutate({
                baseUrl: props.sub2apiConnectionDraft.baseUrl,
                adminApiKey: props.sub2apiConnectionDraft.apiKey || undefined,
                timezone: props.sub2apiConnectionDraft.timezone || "Asia/Shanghai",
                managedProxyPrefix: props.sub2apiConnectionDraft.managedPrefix || "MH-"
              })
            }
            onTest={() =>
              m.testSub2apiConnection.mutate({
                baseUrl: props.sub2apiConnectionDraft.baseUrl,
                adminApiKey: props.sub2apiConnectionDraft.apiKey || undefined
              })
            }
            collapsible={false}
          />

          <Sub2ApiMaintenancePanel
            connected={sub2apiConnected}
            managedProxyCount={props.managedProxyCount}
            pushingLocal={m.pushLocalNodes.isPending}
            checkingQuality={m.qualityCheck.isPending}
            onPushLocal={() => m.pushLocalNodes.mutate()}
            onQualityCheck={() => m.qualityCheck.mutate()}
          />
        </div>

        {/* 导出节点 */}
        <div className="system-col">
          {props.selectedCount === 0 ? (
            <p className="muted small system-export-note">
              ⓘ 导出对象 = 你在「节点池」勾选的节点。当前未选中任何节点 —— 先到「节点池」勾选要导出的节点。
            </p>
          ) : (
            <p className="muted small system-export-note">
              ⓘ 当前已在「节点池」勾选 <strong>{props.selectedCount}</strong> 个节点
              {props.exportableSelectedCount !== props.selectedCount
                ? `（其中 ${props.exportableSelectedCount} 个可导出）`
                : ""}
              。
            </p>
          )}
          <ExportPanel
            host={props.exportHost}
            filename={props.exportFilename}
            selectedCount={props.selectedCount}
            preview={props.exportPreview}
            loading={props.exportPreviewFetching}
            writing={m.writeExport.isPending}
            downloading={props.downloading}
            failedNodeStatus={props.failedNodeStatus}
            onHostChange={props.setExportHost}
            onFilenameChange={props.setExportFilename}
            onFailedNodeStatusChange={props.setFailedNodeStatus}
            onDownload={props.onDownload}
            onWrite={() =>
              props.requestConfirmation({
                title: "确认写入服务器文件",
                description: `将把 ${props.exportableSelectedCount} 个可导出节点写入 generated/sub2api-proxies.json。`,
                detail: "导出严格按当前选择集执行；失败节点状态由下方选项决定。",
                confirmLabel: "写入文件",
                run: async () =>
                  m.writeExport.mutate({
                    selectedHashes: props.selectedHashesList,
                    host: props.exportHost,
                    filename: props.exportFilename,
                    failedNodeStatus: props.failedNodeStatus
                  })
              })
            }
          />
        </div>
      </div>
    </section>
  );
}

/** 状态条上的连接状态芯片 —— 绿点=已连/已配，黄点=待配置 + 引导文案。 */
function StatusChip(props: { label: string; ok: boolean; okText: string; pendingText: string }) {
  return (
    <span className="system-statuschip">
      <span className={`system-statusdot ${props.ok ? "is-ok" : "is-pending"}`} aria-hidden="true" />
      <strong>{props.label}</strong>
      <span className={props.ok ? "tone-ok" : "tone-pending"}>{props.ok ? props.okText : props.pendingText}</span>
    </span>
  );
}

/**
 * Sub2API 运维工具箱 —— 只提供节点验活和幂等推送。
 * 账号绑定始终保持在 Sub2API 现状，不提供迁移或删除入口。
 */
function Sub2ApiMaintenancePanel(props: {
  connected: boolean;
  managedProxyCount: number;
  pushingLocal: boolean;
  checkingQuality: boolean;
  onPushLocal: () => void;
  onQualityCheck: () => void;
}) {
  return (
    <CollapsiblePanel
      title="Sub2API 运维工具"
      storageKey="system-sub2api-maintenance"
      hint="后台会周期性验活并幂等同步健康节点；这里可以手动立即执行一次。"
    >
      <div className="maintenance-row">
        <div className="maintenance-summary">
          <span className="muted small">
            {props.connected ? <>Hive 托管代理 <strong>{props.managedProxyCount}</strong></> : "请先配置 Sub2API 连接"}
          </span>
        </div>
        <div className="button-row wrap">
          <Button
            size="sm"
            variant="secondary"
            icon={<Upload size={14} />}
            loading={props.pushingLocal}
            disabled={!props.connected}
            onClick={props.onPushLocal}
            title="把本地可调度 + 可用的节点推到 Sub2API 远端，代理名自动加托管前缀。Sub2API 按代理标识去重，重复推送幂等。"
          >
            推送本地节点
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Activity size={14} />}
            loading={props.checkingQuality}
            disabled={!props.connected || props.managedProxyCount === 0}
            onClick={props.onQualityCheck}
            title="对每个 Hive 托管代理调用 Sub2API quality-check：让 Sub2API 真实出站测一次，分数回写本地节点 qualityScore。开销大，按需用。"
          >
            质量检查
          </Button>
        </div>
        {!props.connected ? (
          <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
            连接 Sub2API 后这些工具才可用（在上方「Sub2API 连接」配置）。
          </p>
        ) : props.managedProxyCount === 0 ? (
          <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
            还没有 Hive 托管代理 —— 先「推送本地节点」把节点推到 Sub2API，其余工具才有作用对象。
          </p>
        ) : null}
      </div>
    </CollapsiblePanel>
  );
}
