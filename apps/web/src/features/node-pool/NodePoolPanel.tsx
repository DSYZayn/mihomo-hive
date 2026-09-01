import React from "react";
import { AlertTriangle, CheckCircle2, DownloadCloud, Plus, RefreshCw, Save, Search, Trash2, X } from "lucide-react";
import type { NodeDeletionPlan, ProxyNode, SubscriptionImportPreview, SubscriptionSource } from "@mihomo-hive/schemas";
import { Badge, Button, EmptyState, Panel, TextInput } from "../../components/ui.js";
import { formatRegion } from "../nodes/node-utils.js";

export function NodePoolPanel(props: {
  subscriptions: Array<Omit<SubscriptionSource, "lastContent"> & { fetched: boolean; lastContentBytes?: number }>;
  nodes: ProxyNode[];
  busy: boolean;
  importName: string;
  importUrl: string;
  importKeywords: string;
  preview: SubscriptionImportPreview | undefined;
  deletePlan: NodeDeletionPlan | undefined;
  previewing: boolean;
  importing: boolean;
  saving: boolean;
  onImportNameChange: (value: string) => void;
  onImportUrlChange: (value: string) => void;
  onImportKeywordsChange: (value: string) => void;
  onSaveSubscription: () => void;
  onPreviewImport: (source?: { id: string; name: string; url: string; excludeKeywords: string[] }) => void;
  onRepreviewWithKeywords: (keywords: string[]) => void;
  onApplyImport: (keywords: string[]) => void;
  onClearPreview: () => void;
  onApplyDeleteSelected: (forceLocal: boolean) => void;
  onDeleteSubscription: (id: string) => void;
}) {
  const schedulable = props.nodes.filter((node) => node.lifecycleStatus === "schedulable").length;
  const cooling = props.nodes.filter((node) => node.lifecycleStatus === "cooling_down").length;
  const candidate = props.nodes.filter((node) => node.lifecycleStatus === "candidate").length;
  const disabled = props.nodes.filter((node) => node.lifecycleStatus === "disabled").length;

  return (
    <aside className="node-pool-panel">
      <Panel
        title="节点池"
        actions={<Badge tone={schedulable > 0 ? "success" : "warning"}>{schedulable > 0 ? "可调度" : "待处理"}</Badge>}
      >
        <div className="metric-grid compact">
          <Metric label="可调度" value={schedulable} tone="success" />
          <Metric label="候选" value={candidate} tone="info" />
          <Metric label="冷却" value={cooling} tone="warning" />
          <Metric label="停用" value={disabled} tone="neutral" />
        </div>
      </Panel>

      <Panel title="导入订阅">
        <div className="stack">
          <TextInput label="名称" value={props.importName} onChange={props.onImportNameChange} placeholder="primary" />
          <TextInput label="订阅 URL" value={props.importUrl} onChange={props.onImportUrlChange} placeholder="https://example.com/sub" mono />
          <p className="muted small">
            过滤规则在预览弹窗中调整。"保存订阅源" 只保存配置不发起请求；"拉取并预览" 才会下载订阅内容。
          </p>
          <div className="button-row">
            <Button
              variant="secondary"
              icon={<Save size={16} />}
              loading={props.saving}
              disabled={props.busy || !props.importName || !props.importUrl}
              onClick={props.onSaveSubscription}
            >
              仅保存订阅源
            </Button>
            <Button
              icon={<Search size={16} />}
              loading={props.previewing}
              disabled={props.busy || !props.importName || !props.importUrl}
              onClick={() => props.onPreviewImport()}
            >
              拉取并预览
            </Button>
          </div>
        </div>
      </Panel>

      <Panel title="已保存订阅">
        <div className="subscription-list">
          {props.subscriptions.length === 0 ? (
            <EmptyState branded title="还没有订阅源" description="输入订阅链接后先预览，再确认导入节点。" />
          ) : (
            props.subscriptions.map((source) => (
              <div key={source.id} className="subscription-row-card">
                <div className="subscription-row-main">
                  <strong>{source.name}</strong>
                  <span>{source.fetched ? `${source.lastContentBytes ?? 0} bytes` : "已保存"}</span>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<RefreshCw size={14} />}
                  onClick={() =>
                    props.onPreviewImport({
                      id: source.id,
                      name: source.name,
                      url: source.value,
                      excludeKeywords: source.excludeKeywords
                    })
                  }
                >
                  重新导入
                </Button>
                <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => props.onDeleteSubscription(source.id)}>
                  删除
                </Button>
              </div>
            ))
          )}
        </div>
      </Panel>

      {props.preview ? (
        <ImportPreviewDialog
          preview={props.preview}
          initialKeywords={parseKeywords(props.importKeywords)}
          previewing={props.previewing}
          importing={props.importing}
          onClose={props.onClearPreview}
          onApply={props.onApplyImport}
          onRepreview={props.onRepreviewWithKeywords}
        />
      ) : null}
      {props.deletePlan ? (
        <DeletePlanDialog plan={props.deletePlan} onClose={() => props.onApplyDeleteSelected(false)} onForceLocal={() => props.onApplyDeleteSelected(true)} />
      ) : null}
    </aside>
  );
}

function ImportPreviewDialog(props: {
  preview: SubscriptionImportPreview;
  initialKeywords: string[];
  previewing: boolean;
  importing: boolean;
  onClose: () => void;
  onApply: (keywords: string[]) => void;
  onRepreview: (keywords: string[]) => void;
}) {
  const [keywords, setKeywords] = React.useState<string[]>(props.initialKeywords);
  const [draftKeyword, setDraftKeyword] = React.useState("");

  React.useEffect(() => {
    setKeywords(props.initialKeywords);
  }, [props.initialKeywords.join("\n")]); // eslint-disable-line react-hooks/exhaustive-deps

  function addKeyword(raw: string) {
    const cleaned = raw.trim();
    if (!cleaned || keywords.includes(cleaned)) {
      return;
    }
    setKeywords([...keywords, cleaned]);
    setDraftKeyword("");
  }

  function removeKeyword(value: string) {
    setKeywords(keywords.filter((item) => item !== value));
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog wide" role="dialog" aria-modal="true">
        <h2>订阅导入预览</h2>
        <p>
          共解析 {props.preview.summary.total} 个节点，可导入/更新 {props.preview.summary.importable} 个，过滤{" "}
          {props.preview.summary.filtered} 个，其中会从现有节点池删除 {props.preview.summary.deletedByFilter} 个，重复 {props.preview.summary.duplicates} 个。
        </p>

        <section className="dialog-section">
          <header>
            <strong>过滤关键词</strong>
            <span className="muted small">命中关键词的节点不会导入；未托管的同 hash 节点会从池中删除，已推送到 Sub2API 的节点会保留。</span>
          </header>
          <div className="keyword-chips">
            {keywords.length === 0 ? (
              <span className="muted small">未配置关键词，将导入所有解析出的节点。</span>
            ) : (
              keywords.map((keyword) => (
                <button key={keyword} type="button" className="keyword-chip" onClick={() => removeKeyword(keyword)}>
                  <span>{keyword}</span>
                  <X size={12} aria-hidden="true" />
                </button>
              ))
            )}
          </div>
          <div className="keyword-input-row">
            <TextInput
              value={draftKeyword}
              onChange={setDraftKeyword}
              placeholder="输入关键词后按回车或点 +"
            />
            <Button
              variant="secondary"
              icon={<Plus size={16} />}
              disabled={!draftKeyword.trim()}
              onClick={() => addKeyword(draftKeyword)}
            >
              添加
            </Button>
            <Button
              variant="secondary"
              icon={<RefreshCw size={16} />}
              loading={props.previewing}
              onClick={() => props.onRepreview(keywords)}
            >
              用当前关键词重新预览
            </Button>
          </div>
        </section>

        <div className="preview-table-wrap">
          <table className="preview-table">
            <thead>
              <tr>
                <th>动作</th>
                <th>节点</th>
                <th>地区</th>
                <th>协议</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {props.preview.items.slice(0, 160).map((item) => (
                <tr key={`${item.hash}-${item.action}`}>
                  <td><PreviewAction action={item.action} /></td>
                  <td>{item.name}</td>
                  <td>{formatRegion(item.region)}</td>
                  <td>{item.type}</td>
                  <td>{item.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <footer>
          <Button variant="secondary" onClick={props.onClose}>取消</Button>
          <Button
            loading={props.importing}
            disabled={props.preview.summary.importable === 0 && props.preview.summary.deletedByFilter === 0}
            onClick={() => props.onApply(keywords)}
          >
            重新导入这些节点
          </Button>
        </footer>
      </section>
    </div>
  );
}

function DeletePlanDialog(props: { plan: NodeDeletionPlan; onClose: () => void; onForceLocal: () => void }) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog wide" role="dialog" aria-modal="true">
        <h2>节点删除计划</h2>
        <p>{props.plan.message}</p>
        {props.plan.blockingAccounts.length > 0 ? (
          <div className="warning-box">
            <AlertTriangle size={18} />
            <span>仍有 {props.plan.blockingAccounts.length} 个账号绑定到这些代理。请先在 Sub2API 侧完成迁移，再删除节点。</span>
          </div>
        ) : (
          <div className="success-box">
            <CheckCircle2 size={18} />
            <span>没有账号阻塞，可以删除本地节点，并尝试删除对应 Sub2API 代理。</span>
          </div>
        )}
        <footer>
          <Button variant="secondary" onClick={props.onClose}>关闭</Button>
          <Button variant="danger" disabled={!props.plan.canDeleteNow} onClick={props.onForceLocal}>确认删除</Button>
        </footer>
      </section>
    </div>
  );
}

function PreviewAction(props: { action: SubscriptionImportPreview["items"][number]["action"] }) {
  const label = {
    import: "导入",
    update: "更新",
    skip_duplicate: "重复",
    skip_existing: "已存在",
    skip_filtered: "过滤删除"
  }[props.action];
  const tone = props.action === "import" || props.action === "update" ? "success" : props.action === "skip_filtered" ? "warning" : "neutral";
  return <Badge tone={tone}>{label}</Badge>;
}

function Metric(props: { label: string; value: number; tone: "success" | "info" | "warning" | "neutral" }) {
  return (
    <div className={`metric-card metric-${props.tone}`}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function parseKeywords(value: string): string[] {
  return value
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
