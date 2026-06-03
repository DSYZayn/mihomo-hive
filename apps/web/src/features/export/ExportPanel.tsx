import React from "react";
import { Download, FileJson, HardDriveDownload } from "lucide-react";
import type { Sub2ApiExportPreview } from "@mihomo-hive/schemas";
import { Badge, Button, EmptyState, Panel, SelectInput, TextInput } from "../../components/ui.js";

export function ExportPanel(props: {
  host: string;
  filename: string;
  selectedCount: number;
  preview: Sub2ApiExportPreview | undefined;
  loading: boolean;
  writing: boolean;
  downloading: boolean;
  failedNodeStatus: "active" | "inactive";
  onHostChange: (host: string) => void;
  onFilenameChange: (filename: string) => void;
  onFailedNodeStatusChange: (status: "active" | "inactive") => void;
  onDownload: () => void;
  onWrite: () => void;
}) {
  const exportable = props.preview?.exportable ?? 0;
  const excluded = props.preview?.excluded.length ?? 0;
  const examples = props.preview?.export.proxies.slice(0, 4) ?? [];

  return (
    <aside className="export-panel">
      <Panel
        title="导出节点"
        actions={exportable > 0 ? <Badge tone="success">{exportable} 个可导出</Badge> : <Badge tone="warning">等待选择</Badge>}
      >
        <div className="export-stats">
          <Metric label="已选择" value={props.selectedCount} />
          <Metric label="最终导出" value={exportable} />
          <Metric label="被排除" value={excluded} />
        </div>
        <div className="export-fields">
          <TextInput label="导出 Host" value={props.host} onChange={props.onHostChange} placeholder="127.0.0.1" mono />
          <TextInput label="文件名" value={props.filename} onChange={props.onFilenameChange} placeholder="sub2api-proxies.json" mono />
          <SelectInput
            label="失败节点导出状态"
            value={props.failedNodeStatus}
            onChange={(value) => props.onFailedNodeStatusChange(value as "active" | "inactive")}
            options={[
              { label: "未激活", value: "inactive" },
              { label: "激活", value: "active" }
            ]}
          />
        </div>
        {props.selectedCount === 0 ? (
          <EmptyState
            branded
            title="还没有选择导出节点"
            description="在节点表格中筛选目标节点，然后选择要导出的节点。已分配端口的选中节点会进入 JSON。"
          />
        ) : props.loading ? (
          <div className="loading-block">正在计算导出预览...</div>
        ) : (
          <div className="preview-block">
            <div className="reason-grid">
              <Reason label="未选择" value={props.preview?.summary.notSelected ?? 0} />
              <Reason label="非可用" value={props.preview?.summary.notActive ?? 0} />
              <Reason label="无端口" value={props.preview?.summary.missingPort ?? 0} />
            </div>
            {examples.length > 0 ? (
              <pre className="json-preview">
                {JSON.stringify(
                  examples.map((proxy) => ({
                    proxy_key: proxy.proxy_key,
                    name: proxy.name,
                    status: proxy.status
                  })),
                  null,
                  2
                )}
              </pre>
            ) : (
              <EmptyState branded title="当前选择没有可导出节点" description="请先选择已经分配端口的节点。" />
            )}
          </div>
        )}
        <div className="export-actions">
          <Button
            icon={<Download size={16} />}
            disabled={exportable === 0}
            loading={props.downloading}
            onClick={props.onDownload}
          >
            下载 JSON
          </Button>
          <Button
            variant="secondary"
            icon={<HardDriveDownload size={16} />}
            disabled={exportable === 0}
            loading={props.writing}
            onClick={props.onWrite}
          >
            写入服务器文件
          </Button>
        </div>
      </Panel>
      <Panel title="文件结构">
        <div className="format-card">
          <FileJson size={18} />
          <div>
            <strong>Sub2API JSON</strong>
            <span>proxy_key 保持 protocol|host|port|username|password</span>
          </div>
        </div>
      </Panel>
    </aside>
  );
}

function Metric(props: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function Reason(props: { label: string; value: number }) {
  return (
    <div className="reason">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}
