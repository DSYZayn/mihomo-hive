import { Activity, Save } from "lucide-react";
import type { Sub2ApiSafeConnectionConfig } from "@mihomo-hive/schemas";
import { Badge, Button, CollapsiblePanel, Panel, TextInput } from "../../components/ui.js";

/**
 * Sub2API 连接表单：设置与工具页唯一配置入口。
 *
 * 设计原则：
 *   - 这个组件**纯展示**：state 由调用方管理（连接 draft + connection 服务端配置）
 *   - 用稳定的 storageKey 记住展开/折叠状态
 *   - 提交动作（保存、测试）外部 mutation handle 处理
 */
export interface Sub2ApiConnectionDraft {
  baseUrl: string;
  apiKey: string;
  timezone: string;
  managedPrefix: string;
}

export function Sub2ApiConnectionPanel(props: {
  connection: Sub2ApiSafeConnectionConfig | undefined;
  draft: Sub2ApiConnectionDraft;
  saving: boolean;
  testing: boolean;
  onDraftChange: (next: Sub2ApiConnectionDraft) => void;
  onSave: () => void;
  onTest: () => void;
  /** 默认 collapsible；系统页主区可传 false 让它常驻展开 */
  collapsible?: boolean;
}) {
  const connected = Boolean(props.connection?.configured);
  const body = (
    <>
      <div className="sub2api-fields">
        <TextInput
          label="Sub2API 地址"
          value={props.draft.baseUrl}
          onChange={(v) => props.onDraftChange({ ...props.draft, baseUrl: v })}
          placeholder="https://sub2api.example.com"
          mono
        />
        <TextInput
          label={
            props.connection?.apiKeyConfigured && !props.draft.apiKey
              ? "管理员 API Key（已保存，留空不变）"
              : "管理员 API Key"
          }
          value={props.draft.apiKey}
          onChange={(v) => props.onDraftChange({ ...props.draft, apiKey: v })}
          placeholder="x-api-key"
          type="password"
          mono
        />
        <TextInput
          label="时区"
          value={props.draft.timezone}
          onChange={(v) => props.onDraftChange({ ...props.draft, timezone: v })}
          placeholder="Asia/Shanghai"
          mono
        />
        <TextInput
          label="Hive 托管代理前缀"
          value={props.draft.managedPrefix}
          onChange={(v) => props.onDraftChange({ ...props.draft, managedPrefix: v })}
          placeholder="MH-"
          mono
        />
      </div>
      <p className="muted small">
        托管前缀只用于识别 Hive 自己推送的代理。系统只做代理验活和幂等同步，不会读取或修改账号绑定。
      </p>
      <div className="button-row wrap">
        <Button
          icon={<Save size={16} />}
          loading={props.saving}
          disabled={!props.draft.baseUrl || (!props.draft.apiKey && !props.connection?.apiKeyConfigured)}
          onClick={props.onSave}
          title="把连接信息（含 API Key 加密后）保存到服务端 settings 表。下次启动自动读取。"
        >
          保存连接
        </Button>
        <Button
          variant="secondary"
          icon={<Activity size={16} />}
          loading={props.testing}
          disabled={!props.draft.baseUrl || (!props.draft.apiKey && !props.connection?.apiKeyConfigured)}
          onClick={props.onTest}
          title="用当前填写的地址 + API Key 发一次试探请求（无需先保存），回报代理与账号总数。"
        >
          测试连接
        </Button>
      </div>
    </>
  );

  const badge = <Badge tone={connected ? "success" : "warning"}>{connected ? "已连接" : "待配置"}</Badge>;
  if (props.collapsible === false) {
    return (
      <Panel
        title="Sub2API 连接"
        actions={badge}
        hint="Sub2API baseUrl + 管理员 API Key + 托管代理前缀。节点幂等推送和导出依赖这里。"
      >
        {body}
      </Panel>
    );
  }
  return (
      <CollapsiblePanel
      title="Sub2API 连接"
      storageKey="system-sub2api-connection"
      defaultOpen={!connected}
      hint="Sub2API baseUrl + 管理员 API Key + 托管代理前缀。节点幂等推送和导出依赖这里。"
      actions={badge}
    >
      {body}
    </CollapsiblePanel>
  );
}
