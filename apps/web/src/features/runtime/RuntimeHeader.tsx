import type React from "react";
import { Activity, LogOut, Monitor, Moon, Network, Server, ShieldCheck, Sun } from "lucide-react";
import { Badge, BrandMark, Button } from "../../components/ui.js";
import type { Theme } from "../../hooks/useTheme.js";

// "system" 是 P5-AK 引入的新 workspace（替代原 "runtime"）—— 把 Sub2API/codex-tool
// 连接、运维工具箱、账号接管、节点导出都收纳进去。"runtime" 别名保留向前
// 兼容（localStorage 里可能有用户旧值），App.tsx 读取时会把 "runtime" 映射成 "system"。
export type WorkspaceId = "nodes" | "automation" | "account_fleet" | "system";

interface WorkspaceTab {
  id: WorkspaceId;
  label: string;
}

const tabs: WorkspaceTab[] = [
  { id: "nodes", label: "节点池" },
  { id: "automation", label: "代理编排" },
  { id: "account_fleet", label: "账号编排" },
  { id: "system", label: "设置与工具" }
];

export function RuntimeHeader(props: {
  running: boolean;
  expectedListeners?: number | undefined;
  reachableListeners?: number | undefined;
  nodes: number;
  active: number;
  assigned: number;
  listeners?: number;
  workspace: WorkspaceId;
  theme: Theme;
  onWorkspaceChange: (next: WorkspaceId) => void;
  onThemeChange: (next: Theme) => void;
  onLogout: () => void;
}) {
  const missingListeners = Math.max(0, (props.expectedListeners ?? 0) - (props.reachableListeners ?? 0));
  const runtimeHealthy = props.running && missingListeners === 0;
  return (
    <header className="app-header">
      <div className="brand">
        <BrandMark size="sm" />
        <div>
          <h1>Mihomo Hive</h1>
          <p>固定出口节点池 · 账号自动注册与续登</p>
        </div>
      </div>
      <nav
        className="header-tabs"
        aria-label="工作区"
        style={{
          ["--tab-count" as string]: tabs.length,
          ["--active-index" as string]: tabs.findIndex((t) => t.id === props.workspace)
        }}
      >
        <span className="header-tabs-indicator" aria-hidden="true" />
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={props.workspace === tab.id}
            className={props.workspace === tab.id ? "is-active" : ""}
            onClick={() => props.onWorkspaceChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <div className="header-metrics">
        <HeaderMetric
          icon={<Server size={16} />}
          label="Mihomo"
          value={!props.running ? "未运行" : missingListeners > 0 ? `缺失 ${missingListeners}` : "运行中"}
          ok={runtimeHealthy}
        />
        <HeaderMetric icon={<Network size={16} />} label="节点" value={String(props.nodes)} />
        <HeaderMetric icon={<Activity size={16} />} label="可用" value={String(props.active)} ok={props.active > 0} />
        <HeaderMetric icon={<ShieldCheck size={16} />} label="端口" value={String(props.assigned)} />
        {props.listeners !== undefined ? <HeaderMetric icon={<Server size={16} />} label="Listener" value={String(props.listeners)} /> : null}
      </div>
      <div className="header-actions">
        <ThemeSwitcher theme={props.theme} onChange={props.onThemeChange} />
        <Button variant="secondary" icon={<LogOut size={16} />} onClick={props.onLogout}>
          退出
        </Button>
      </div>
    </header>
  );
}

function ThemeSwitcher(props: { theme: Theme; onChange: (next: Theme) => void }) {
  const options: { value: Theme; label: string; icon: React.ReactNode }[] = [
    { value: "auto", label: "跟随系统", icon: <Monitor size={14} /> },
    { value: "light", label: "浅色", icon: <Sun size={14} /> },
    { value: "dark", label: "深色", icon: <Moon size={14} /> }
  ];
  return (
    <div className="theme-switcher" role="group" aria-label="主题">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={props.theme === option.value ? "is-active" : ""}
          onClick={() => props.onChange(option.value)}
          title={option.label}
          aria-label={option.label}
        >
          {option.icon}
        </button>
      ))}
    </div>
  );
}

function HeaderMetric(props: { icon: React.ReactNode; label: string; value: string; ok?: boolean }) {
  return (
    <div className="header-metric">
      {props.icon}
      <span>{props.label}</span>
      <Badge tone={props.ok === undefined ? "neutral" : props.ok ? "success" : "warning"}>{props.value}</Badge>
    </div>
  );
}
