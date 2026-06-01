import React from "react";
import { Activity, CheckCircle2, Plus, Save, Trash2, XCircle } from "lucide-react";
import type { AccountFleetSpec } from "@mihomo-hive/schemas";
import {
  Badge,
  Button,
  Checkbox,
  CollapsiblePanel,
  IconButton,
  InfoTip,
  Panel,
  SelectInput,
  Switch,
  TextInput
} from "../../components/ui.js";

/** 常见、风控风险较低的注册邮箱子域名前缀示例(看起来像正常邮件子域,不像一次性邮箱)。 */
const SAMPLE_SUBDOMAIN_PREFIXES = ["mail", "mx", "inbox", "post", "me", "box", "mbox", "send", "mail2", "relay"];

/**
 * 注册邮箱域名池编辑器:每次注册从"启用"的域名里随机抽一个,把风控指纹分散到多个自定义子域名。
 * 关掉某个域名(Switch)即实时停用——下个注册不再抽到它(方便随时停用被风控的域名)。
 * 池为空(或全部禁用)时,系统回退到下方的"单一 mail domain"。
 */
function MailDomainPool(props: {
  domains: { domain: string; enabled: boolean }[];
  onChange: (next: { domain: string; enabled: boolean }[]) => void;
}) {
  const list = props.domains;
  const setAt = (i: number, patch: Partial<{ domain: string; enabled: boolean }>) =>
    props.onChange(list.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
  const remove = (i: number) => props.onChange(list.filter((_, idx) => idx !== i));
  const add = () => props.onChange([...list, { domain: "", enabled: true }]);
  const enabledCount = list.filter((d) => d.enabled && d.domain.trim()).length;
  return (
    <div className="mail-domain-pool">
      <div className="config-subgroup-label">
        注册邮箱域名池（随机抽取）
        <InfoTip text="每次注册从“启用”的域名里随机抽一个，分散风控指纹。关掉某个域名即实时停用，下个注册不再抽到它。池为空时回退到下方单一 mail domain。" />
        <span className="muted" style={{ marginLeft: 8, fontWeight: 400 }}>
          {enabledCount} 个启用 / 共 {list.length} 个
        </span>
      </div>
      {list.length === 0 ? (
        <div className="muted" style={{ fontSize: 13, margin: "4px 0 8px" }}>
          尚未配置域名池——当前用下方单一 mail domain。点“添加域名”开始配置多域名随机。
        </div>
      ) : (
        <div className="domain-rows">
          {list.map((d, i) => (
            <div className="domain-row" key={i}>
              <TextInput
                label=""
                value={d.domain}
                onChange={(v) => setAt(i, { domain: v })}
                placeholder="mail.yourdomain.com"
                mono
              />
              <Switch
                checked={d.enabled}
                onChange={(c) => setAt(i, { enabled: c })}
                {...(d.enabled ? {} : { label: "停用" })}
                title={d.enabled ? "已启用(会被随机抽到)" : "已停用(不会被抽到)"}
              />
              <IconButton label="删除该域名" icon={<Trash2 size={15} />} onClick={() => remove(i)} />
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
        <Button onClick={add} icon={<Plus size={15} />} variant="ghost" size="sm">
          添加域名
        </Button>
        <span className="muted" style={{ fontSize: 12.5 }}>
          常见低风险前缀:{SAMPLE_SUBDOMAIN_PREFIXES.join("、")} —— 如 <code>mail.yourdomain.com</code>
        </span>
      </div>
    </div>
  );
}

/**
 * codex-tool 连接表单（P5-AK 从 AccountFleetSpecPanel 抽出复用）。
 *
 * 这个区块对应 AccountFleetSpec.codexTool 子树 —— 跟整体 spec 是包含关系，
 * 但**只编辑 codexTool 子树**：保存时调用 saveCodexTool 接口（router 端
 * 已实现，P5-AF）；其它 spec 字段不受影响。这样系统页的连接配置不会污染
 * 账号编排页的策略编辑状态。
 *
 * `lastTest` / `onTest` 配合 P5-AF 的连通测试 endpoint：调用 sms countries
 * 一次走全链路（binPath → SkyMail → 接码 provider），inline 显示结果。
 *
 * 折叠状态持久化复用 P5-AF 同一 storageKey（account-fleet-codex-tool）—— 用户
 * 在某处收起后另一处也是收起。账号编排页移除该面板后 storageKey 仍可继续用，
 * 仅作为系统页的折叠记忆。
 */
export type CodexToolTestResult =
  | { ok: true; provider: string; service: string; countriesSampled: number; totalCountries: number }
  | { ok: false; error: string };

export function CodexToolConnectionPanel(props: {
  draft: AccountFleetSpec["codexTool"];
  saving: boolean;
  testing: boolean;
  lastTest?: CodexToolTestResult | null | undefined;
  onDraftChange: (next: AccountFleetSpec["codexTool"]) => void;
  onSave: () => void;
  onTest: () => void;
  collapsible?: boolean;
}) {
  const draft = props.draft;
  const configured = Boolean(
    draft.binPath &&
      draft.skymail.baseUrl &&
      draft.skymail.adminEmail &&
      draft.chatgpt.codexClientId &&
      draft.phoneSms.apiKeyRef
  );
  const patch = (updater: (c: AccountFleetSpec["codexTool"]) => AccountFleetSpec["codexTool"]) => {
    props.onDraftChange(updater(draft));
  };
  const body = (
    <>
      <div className="form-grid">
        <TextInput
          label="二进制路径"
          value={draft.binPath}
          onChange={(v) => patch((c) => ({ ...c, binPath: v }))}
          placeholder="/home/USER/.local/bin/codex-tool"
          mono
        />
        <NumberInput
          label="login 超时（秒）"
          value={Math.round(draft.timeouts.loginMs / 1000)}
          min={5}
          onChange={(v) => patch((c) => ({ ...c, timeouts: { ...c.timeouts, loginMs: v * 1000 } }))}
        />
        <NumberInput
          label="register 超时（秒）"
          value={Math.round(draft.timeouts.registerMs / 1000)}
          min={5}
          onChange={(v) => patch((c) => ({ ...c, timeouts: { ...c.timeouts, registerMs: v * 1000 } }))}
        />
      </div>
      <div className="config-subgroup-label">SkyMail（邮箱 OTP）</div>
      <div className="form-grid">
        <TextInput
          label="base URL"
          value={draft.skymail.baseUrl}
          onChange={(v) => patch((c) => ({ ...c, skymail: { ...c.skymail, baseUrl: v } }))}
          placeholder="https://mail.example.com"
          mono
        />
        <TextInput
          label="管理员邮箱"
          value={draft.skymail.adminEmail}
          onChange={(v) => patch((c) => ({ ...c, skymail: { ...c.skymail, adminEmail: v } }))}
          placeholder="admin@example.com"
          mono
        />
        <TextInput
          label="管理员密码"
          value={draft.skymail.adminPasswordRef}
          onChange={(v) => patch((c) => ({ ...c, skymail: { ...c.skymail, adminPasswordRef: v } }))}
          type="password"
          mono
        />
      </div>
      <div className="config-subgroup-label">ChatGPT OAuth</div>
      <MailDomainPool
        domains={draft.chatgpt.mailDomains}
        onChange={(next) => patch((c) => ({ ...c, chatgpt: { ...c.chatgpt, mailDomains: next } }))}
      />
      <div className="form-grid">
        <TextInput
          label="mail domain（回退,池为空时用）"
          value={draft.chatgpt.mailDomain}
          onChange={(v) => patch((c) => ({ ...c, chatgpt: { ...c.chatgpt, mailDomain: v } }))}
          placeholder="example.com"
          mono
        />
        <TextInput
          label="chat web client_id"
          value={draft.chatgpt.chatWebClientId}
          onChange={(v) => patch((c) => ({ ...c, chatgpt: { ...c.chatgpt, chatWebClientId: v } }))}
          placeholder="app_xxx"
          mono
        />
        <TextInput
          label="codex client_id"
          value={draft.chatgpt.codexClientId}
          onChange={(v) => patch((c) => ({ ...c, chatgpt: { ...c.chatgpt, codexClientId: v } }))}
          placeholder="app_xxx"
          mono
        />
      </div>
      <div className="config-subgroup-label">接码平台</div>
      <div className="form-grid">
        <SelectInput
          label="provider"
          value={draft.phoneSms.provider}
          onChange={(v) =>
            patch((c) => ({
              ...c,
              phoneSms: {
                ...c.phoneSms,
                provider: v as AccountFleetSpec["codexTool"]["phoneSms"]["provider"]
              }
            }))
          }
          options={[
            { label: "HeroSMS", value: "herosms" },
            { label: "5sim", value: "fivesim" },
            { label: "NexSMS", value: "nexsms" }
          ]}
        />
        <TextInput
          label="API key"
          value={draft.phoneSms.apiKeyRef}
          onChange={(v) => patch((c) => ({ ...c, phoneSms: { ...c.phoneSms, apiKeyRef: v } }))}
          type="password"
          mono
        />
        <TextInput
          label="service code"
          value={draft.phoneSms.service}
          onChange={(v) => patch((c) => ({ ...c, phoneSms: { ...c.phoneSms, service: v } }))}
          placeholder="dr"
          mono
        />
      </div>
      <div className="config-subgroup-label">出口代理（codex-tool 走的本地节点）</div>
      <div className="form-grid">
        <SelectInput
          label="模式"
          value={draft.egress.mode}
          onChange={(v) =>
            patch((c) => ({
              ...c,
              egress: { ...c.egress, mode: v as AccountFleetSpec["codexTool"]["egress"]["mode"] }
            }))
          }
          options={[
            { label: "managed-node（按质量+负载加权随机）", value: "managed-node" },
            { label: "pinned-node（钉死一个节点）", value: "pinned-node" },
            { label: "none（不走本地代理直连）", value: "none" }
          ]}
        />
        {draft.egress.mode === "pinned-node" ? (
          <TextInput
            label="节点 hash"
            value={draft.egress.pinnedNodeHash ?? ""}
            onChange={(v) =>
              patch((c) => ({ ...c, egress: { ...c.egress, pinnedNodeHash: v.trim() || null } }))
            }
            placeholder="本地节点 hash 前缀（节点池里看）"
            mono
          />
        ) : null}
      </div>
      <div className="config-subgroup-label">
        外置 Agent（推荐）
        <InfoTip text="让 codex-tool 跑在桌面真实 macOS/Windows 上（codex-tool serve），Hive 经 HTTP 调它，绕开 Linux 容器 headless 浏览器被 OpenAI 风控质询的问题。关闭=沿用容器内本地 subprocess。" />
      </div>
      <div className="form-grid">
        <label className="field">
          <span>启用外置 agent</span>
          <Checkbox
            checked={draft.remoteAgent.enabled}
            onChange={(v) => patch((c) => ({ ...c, remoteAgent: { ...c.remoteAgent, enabled: v } }))}
            label={draft.remoteAgent.enabled ? "走 HTTP agent" : "走本地 subprocess"}
          />
        </label>
        {draft.remoteAgent.enabled ? (
          <>
            <TextInput
              label="agent URL（连接 host）"
              value={draft.remoteAgent.url}
              onChange={(v) => patch((c) => ({ ...c, remoteAgent: { ...c.remoteAgent, url: v.trim() } }))}
              placeholder="http://192.168.5.20:8765"
              mono
            />
            <TextInput
              label="bearer token"
              value={draft.remoteAgent.tokenRef}
              onChange={(v) => patch((c) => ({ ...c, remoteAgent: { ...c.remoteAgent, tokenRef: v } }))}
              type="password"
              mono
            />
            <NumberInput
              label="HTTP 超时余量（秒）"
              value={Math.round(draft.remoteAgent.requestTimeoutPaddingMs / 1000)}
              min={0}
              onChange={(v) =>
                patch((c) => ({ ...c, remoteAgent: { ...c.remoteAgent, requestTimeoutPaddingMs: v * 1000 } }))
              }
            />
            <label className="field">
              <span>调用前健康检查</span>
              <Checkbox
                checked={draft.remoteAgent.healthCheck}
                onChange={(v) => patch((c) => ({ ...c, remoteAgent: { ...c.remoteAgent, healthCheck: v } }))}
                label="先 GET /health，不健康跳过本轮"
              />
            </label>
          </>
        ) : null}
      </div>
      <div className="config-subgroup-label">
        动态出口（codex-egress 单口）
        <InfoTip text="开启后 Mihomo 额外渲染一个唯一鉴权口（hive-codex）+ codex-egress select 组。Hive 选好节点后切该组 → 外置 agent 经此口出去即走选定节点。对外只暴露一个鉴权端口，真实出口仍由 Hive 选节点逻辑分发。需配合外置 agent 使用。" />
      </div>
      <div className="form-grid">
        <label className="field">
          <span>启用动态出口</span>
          <Checkbox
            checked={draft.codexEgress.dynamic}
            onChange={(v) => patch((c) => ({ ...c, codexEgress: { ...c.codexEgress, dynamic: v } }))}
            label={draft.codexEgress.dynamic ? "Hive 动态切节点" : "关闭（agent 自带出口）"}
            disabled={!draft.remoteAgent.enabled}
          />
        </label>
        {draft.codexEgress.dynamic ? (
          <>
            <TextInput
              label="Mihomo 地址（agent 回连）"
              value={draft.codexEgress.host}
              onChange={(v) => patch((c) => ({ ...c, codexEgress: { ...c.codexEgress, host: v.trim() } }))}
              placeholder="192.168.5.8（Hive LAN IP）"
              mono
            />
            <NumberInput
              label="监听端口"
              value={draft.codexEgress.port}
              min={1}
              max={65535}
              onChange={(v) => patch((c) => ({ ...c, codexEgress: { ...c.codexEgress, port: v } }))}
            />
            <TextInput
              label="绑定地址"
              value={draft.codexEgress.bindHost}
              onChange={(v) => patch((c) => ({ ...c, codexEgress: { ...c.codexEgress, bindHost: v.trim() } }))}
              placeholder="0.0.0.0"
              mono
            />
          </>
        ) : null}
      </div>
      <div className="spec-save-bar" style={{ marginTop: 12 }}>
        <Button
          icon={<Save size={16} />}
          loading={props.saving}
          onClick={() => {
            props.onSave();
            try {
              window.localStorage.setItem("mihomo-hive.panel.account-fleet-codex-tool", "0");
            } catch {
              // ignore
            }
          }}
        >
          保存 codex-tool 配置
        </Button>
        <Button
          variant="secondary"
          icon={<Activity size={16} />}
          loading={props.testing}
          onClick={props.onTest}
          title="用当前填写的配置（无需先保存）调一次 codex-tool sms countries，验证二进制可执行 + SkyMail 链路 + 接码 apiKey 都对。不写库、不下发任务。"
        >
          测试连通
        </Button>
        {props.lastTest ? (
          props.lastTest.ok ? (
            <span
              className="muted small"
              title={`provider=${props.lastTest.provider} service=${props.lastTest.service}`}
            >
              <CheckCircle2 size={12} style={{ verticalAlign: "middle", marginRight: 4, color: "var(--success)" }} />
              连通正常（{props.lastTest.provider} · 抽样 {props.lastTest.countriesSampled}/{props.lastTest.totalCountries} 个地区）
            </span>
          ) : (
            <span className="muted small" title={props.lastTest.error}>
              <XCircle size={12} style={{ verticalAlign: "middle", marginRight: 4, color: "var(--danger)" }} />
              连通失败：{truncateError(props.lastTest.error)}
            </span>
          )
        ) : null}
      </div>
    </>
  );
  const badge = (
    <Badge tone={configured ? "success" : "warning"}>{configured ? "已配置" : "待配置"}</Badge>
  );
  if (props.collapsible === false) {
    return (
      <Panel
        title="codex-tool 连接"
        actions={badge}
        hint="codex-tool 二进制路径 + SkyMail + ChatGPT OAuth + 接码 provider + 出口代理模式。系统级配置：账号编排和账号接管都依赖这里。"
      >
        {body}
      </Panel>
    );
  }
  return (
    <CollapsiblePanel
      title="codex-tool 连接"
      storageKey="account-fleet-codex-tool"
      defaultOpen={!configured}
      hint="codex-tool 二进制路径 + SkyMail + ChatGPT OAuth + 接码 provider + 出口代理模式。系统级配置：账号编排和账号接管都依赖这里。"
      actions={badge}
    >
      {body}
    </CollapsiblePanel>
  );
}

function truncateError(s: string, max = 80): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * 项目规范的 NumberInput —— 跟 OrchestrationSpecPanel / AccountFleetSpecPanel 里的本地
 * NumberInput 同款 className 和行为。这里复制一份是为了让 CodexToolConnectionPanel 可独立
 * 复用，不依赖 SpecPanel 内部实现。未来 ui.tsx 可以收口三处共用。
 */
function NumberInput(props: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (next: number) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        className="text-input font-mono"
        type="number"
        value={Number.isFinite(props.value) ? props.value : 0}
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) props.onChange(next);
        }}
      />
    </label>
  );
}
