import React from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Info, Loader2, X } from "lucide-react";

export type Tone = "neutral" | "success" | "danger" | "warning" | "info";

export function BrandMark(props: {
  size?: "sm" | "md" | "lg" | "hero" | "empty";
  className?: string;
  decorative?: boolean;
}) {
  const size = props.size ?? "md";
  return (
    <span
      className={`brand-mark-art brand-mark-art-${size} ${props.className ?? ""}`}
      role={props.decorative ? undefined : "img"}
      aria-label={props.decorative ? undefined : "Mihomo Hive"}
      aria-hidden={props.decorative ? true : undefined}
    >
      <img className="brand-image brand-image-light" src="/brand/app-icon-light-512.png" alt="" draggable={false} />
      <img className="brand-image brand-image-dark" src="/brand/app-icon-dark-512.png" alt="" draggable={false} />
    </span>
  );
}

export function Button(props: {
  children: React.ReactNode;
  icon?: React.ReactNode | undefined;
  variant?: "primary" | "secondary" | "ghost" | "danger" | undefined;
  size?: "sm" | "md" | undefined;
  disabled?: boolean | undefined;
  loading?: boolean | undefined;
  title?: string | undefined;
  onClick?: (() => void) | undefined;
  type?: "button" | "submit" | undefined;
}) {
  const variant = props.variant ?? "primary";
  const size = props.size ?? "md";
  return (
    <button
      className={`ui-button ui-button-${variant} ui-button-${size}`}
      disabled={props.disabled || props.loading}
      title={props.title}
      type={props.type ?? "button"}
      onClick={props.onClick}
    >
      {props.loading ? <Loader2 className="animate-spin" size={16} /> : props.icon}
      <span>{props.children}</span>
    </button>
  );
}

export function IconButton(props: {
  label: string;
  icon: React.ReactNode;
  disabled?: boolean | undefined;
  onClick?: (() => void) | undefined;
}) {
  return (
    <button className="icon-button" disabled={props.disabled} title={props.label} type="button" onClick={props.onClick}>
      {props.icon}
      <span className="sr-only">{props.label}</span>
    </button>
  );
}

export function TextInput(props: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
  type?: string | undefined;
  mono?: boolean | undefined;
  disabled?: boolean | undefined;
  /**
   * 浏览器自动填充策略：
   *   - "off"             普通字段（默认），告诉浏览器别填
   *   - "new-password"    高敏字段（API key / token）+ 真新密码字段。Chrome 不会用旧密码填
   *   - "current-password" 登录密码
   * 默认 "off"。type==="password" 时若调用方未显式传，默认 "new-password" 防止
   * 浏览器把账号登录密码塞到 API key 框这种荒唐场景。
   */
  autoComplete?: "off" | "new-password" | "current-password" | "username" | "email" | "url" | undefined;
  name?: string;
}) {
  const autoComplete = props.autoComplete ?? (props.type === "password" ? "new-password" : "off");
  const input = (
    <input
      className={`text-input ${props.mono ? "font-mono" : ""}`}
      value={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.value)}
      placeholder={props.placeholder}
      type={props.type ?? "text"}
      autoComplete={autoComplete}
      name={props.name}
      // 关闭浏览器智能填充（旧 Safari/Firefox）
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-form-type="other"
      data-lpignore="true"  /* LastPass */
      data-1p-ignore="true" /* 1Password */
    />
  );
  if (!props.label) {
    return input;
  }
  return (
    <label className="field">
      <span>{props.label}</span>
      {input}
    </label>
  );
}

export function SelectInput(props: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
  disabled?: boolean | undefined;
}) {
  const select = (
    <span className="select-wrap">
      <select className="select-input" value={props.value} disabled={props.disabled} onChange={(event) => props.onChange(event.target.value)}>
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown size={15} />
    </span>
  );
  if (!props.label) {
    return select;
  }
  return (
    <label className="field">
      <span>{props.label}</span>
      {select}
    </label>
  );
}

/**
 * 统一分页器（P6-17）—— 全项目表格共用：每页大小选择 + 范围 + 上/下一页。
 * page 为 0-based。pageSize 选项默认 25/50/100/200。
 */
export function Pager(props: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  pageSizeOptions?: number[];
}) {
  const opts = props.pageSizeOptions ?? [25, 50, 100, 200];
  const from = props.total === 0 ? 0 : props.page * props.pageSize + 1;
  const to = Math.min((props.page + 1) * props.pageSize, props.total);
  return (
    <div className="pager">
      <span className="pager-size">
        每页
        <select
          className="select-input pager-size-select"
          value={String(props.pageSize)}
          onChange={(e) => props.onPageSizeChange(Number(e.target.value))}
        >
          {opts.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </span>
      <span className="pager-range muted small">
        {from}–{to} / {props.total}
      </span>
      <button
        type="button"
        className="pager-btn"
        disabled={props.page <= 0}
        onClick={() => props.onPageChange(props.page - 1)}
        aria-label="上一页"
      >
        <ChevronLeft size={15} />
      </button>
      <button
        type="button"
        className="pager-btn"
        disabled={props.page >= props.pageCount - 1}
        onClick={() => props.onPageChange(props.page + 1)}
        aria-label="下一页"
      >
        <ChevronRight size={15} />
      </button>
    </div>
  );
}

export function Checkbox(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`checkbox ${props.disabled ? "is-disabled" : ""}`}>
      <input
        checked={props.checked}
        disabled={props.disabled}
        type="checkbox"
        onChange={(event) => props.onChange(event.target.checked)}
      />
      {props.label ? <span>{props.label}</span> : null}
    </label>
  );
}

export function Switch(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  title?: string;
  label?: string;
}) {
  return (
    <label className={`switch ${props.disabled ? "is-disabled" : ""}`} title={props.title}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span className="switch-track">
        <span className="switch-knob" />
      </span>
      {props.label ? <span className="switch-label">{props.label}</span> : null}
    </label>
  );
}

export function Badge(props: { children: React.ReactNode; tone?: Tone }) {
  return <span className={`badge badge-${props.tone ?? "neutral"}`}>{props.children}</span>;
}

export function Panel(props: {
  title?: string;
  actions?: React.ReactNode;
  /** 如果给了，会在 panel-header 最右端渲染 InfoTip；这样无论 actions 含什么都保证 ℹ️ 永远在末尾。 */
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${props.className ?? ""}`}>
      {props.title || props.actions || props.hint ? (
        <header className="panel-header">
          {props.title ? <h2>{props.title}</h2> : <span />}
          <span className="panel-header-trailing">
            {props.actions}
            {props.hint ? <InfoTip text={props.hint} /> : null}
          </span>
        </header>
      ) : null}
      <div className="panel-body">{props.children}</div>
    </section>
  );
}

/**
 * Panel 的可折叠版本：标题旁有展开/收起箭头，body 在收起时不渲染。
 * 默认状态由 props.defaultOpen 决定；状态持久化到 localStorage 的 storageKey。
 */
export function CollapsiblePanel(props: {
  title: string;
  actions?: React.ReactNode;
  defaultOpen?: boolean;
  storageKey?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(() => {
    if (!props.storageKey) return props.defaultOpen ?? false;
    try {
      const stored = window.localStorage.getItem(`mihomo-hive.panel.${props.storageKey}`);
      if (stored === null) return props.defaultOpen ?? false;
      return stored === "1";
    } catch {
      return props.defaultOpen ?? false;
    }
  });
  React.useEffect(() => {
    if (!props.storageKey) return;
    try {
      window.localStorage.setItem(`mihomo-hive.panel.${props.storageKey}`, open ? "1" : "0");
    } catch {
      // ignore
    }
  }, [open, props.storageKey]);
  return (
    <section className="panel collapsible-panel">
      <header
        className="panel-header collapsible-header"
        onClick={() => setOpen((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <span className="collapsible-trigger">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <h2>{props.title}</h2>
        {props.actions ? (
          <span className="collapsible-actions" onClick={(e) => e.stopPropagation()}>
            {props.actions}
          </span>
        ) : null}
        {props.hint ? <InfoTip text={props.hint} /> : null}
      </header>
      {open ? <div className="panel-body">{props.children}</div> : null}
    </section>
  );
}

/**
 * 信息图标 + 自定义 hover/focus tooltip。
 *
 * 原本用 native `title` attr，浏览器 tooltip 延迟 ~500ms 出现且样式不可控，
 * 在 panel header 里几乎用户看不到。改为 CSS popover：鼠标悬停或键盘 focus
 * 时立刻显示，悬停在 popover 上也不消失。tooltip 用 absolute 定位避免被父级 overflow 裁掉。
 */
export function InfoTip(props: { text: string }) {
  return (
    <span className="info-tip-wrap" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="info-tip"
        aria-label={props.text}
      >
        <Info size={13} />
      </button>
      <span role="tooltip" className="info-tip-popover">{props.text}</span>
    </span>
  );
}

// —— Dropdown：点击触发器展开菜单，点击菜单项后自动关闭；点击外部 / Esc 也关闭 ——

export function Dropdown(props: {
  trigger: React.ReactNode;
  align?: "left" | "right";
  /**
   * 触发器外层 className（用于 layout 控制），不会影响菜单样式。
   */
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    function onClickOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    function onEsc(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div className={`dropdown ${props.className ?? ""}`} ref={ref}>
      <button
        type="button"
        className="dropdown-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {props.trigger}
      </button>
      {open ? (
        <div
          className={`dropdown-menu dropdown-menu-${props.align ?? "right"}`}
          role="menu"
          onClick={() => setOpen(false)}
        >
          {props.children}
        </div>
      ) : null}
    </div>
  );
}

export function DropdownGroup(props: { label?: string; children: React.ReactNode }) {
  return (
    <div className="dropdown-group">
      {props.label ? <div className="dropdown-group-label">{props.label}</div> : null}
      {props.children}
    </div>
  );
}

export function DropdownItem(props: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`dropdown-item ${props.danger ? "dropdown-item-danger" : ""}`}
      disabled={props.disabled}
      onClick={props.onClick}
      title={props.hint}
    >
      {props.icon ? <span className="dropdown-item-icon">{props.icon}</span> : null}
      <span className="dropdown-item-label">{props.children}</span>
    </button>
  );
}

export function EmptyState(props: {
  icon?: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
  branded?: boolean;
}) {
  return (
    <div className={`empty-state ${props.branded ? "empty-state-branded" : ""}`}>
      {props.branded && !props.icon ? <BrandMark size="empty" decorative /> : null}
      {props.icon ? <div className="empty-icon">{props.icon}</div> : null}
      <h3>{props.title}</h3>
      <p>{props.description}</p>
      {props.action ? <div>{props.action}</div> : null}
    </div>
  );
}

export interface ToastMessage {
  id: string;
  tone: Exclude<Tone, "neutral">;
  title: string;
  detail?: string | undefined;
}

export function ToastStack(props: { messages: ToastMessage[]; onDismiss: (id: string) => void }) {
  return (
    <div className="toast-stack">
      {props.messages.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.tone}`}>
          <div className="toast-icon">
            {toast.tone === "success" ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
          </div>
          <div>
            <div className="toast-title">{toast.title}</div>
            {toast.detail ? <div className="toast-detail">{toast.detail}</div> : null}
          </div>
          <button type="button" onClick={() => props.onDismiss(toast.id)}>
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  description: string;
  detail?: React.ReactNode | undefined;
  confirmLabel: string;
  dangerous?: boolean | undefined;
  loading?: boolean | undefined;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!props.open) {
    return null;
  }
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">{props.title}</h2>
        <p>{props.description}</p>
        {props.detail ? <div className="dialog-detail">{props.detail}</div> : null}
        <footer>
          <Button variant="secondary" disabled={props.loading} onClick={props.onCancel}>
            取消
          </Button>
          <Button
            variant={props.dangerous ? "danger" : "primary"}
            loading={props.loading}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </Button>
        </footer>
      </section>
    </div>
  );
}
