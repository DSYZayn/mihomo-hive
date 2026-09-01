import React from "react";
import {
  Activity,
  Archive,
  Check,
  CheckSquare,
  CircleDashed,
  MoreHorizontal,
  PauseCircle,
  PlayCircle,
  Plug,
  RefreshCw,
  RotateCcw,
  Replace,
  Snowflake,
  Trash2,
  XSquare
} from "lucide-react";
import type { ProxyNode } from "@mihomo-hive/schemas";
import { Badge, Button, Dropdown, DropdownGroup, DropdownItem } from "../../components/ui.js";

export interface NodeToolbarProps {
  totalNodes: number;
  filteredCount: number;
  schedulableCount: number;
  selectedCount: number;
  selectedWithPortCount: number;
  selectedUntestedCount: number;
  withPortCount: number;
  busy: boolean;
  attaching: boolean;
  testing: boolean;
  enabling: boolean;
  rebuilding: boolean;
  resetting: boolean;
  onAttach: () => void;
  onTestSelected: () => void;
  onTestAll: () => void;
  onEnableSelected: () => void;
  /** 紧急兜底：用当前 DB 状态强制重新渲染 mihomo.yaml + reload。不动端口、不推 Sub2API。 */
  onRebuildMihomo: () => void;
  /** 重置所选节点的编排意图（清 intent_role / backoff / health_score），让 reconcile 重新评估。
   *  用于恢复被误判 quarantined / evicted 的节点。 */
  onResetIntent: () => void;
  onDisableSelected: () => void;
  onCoolingDownSelected: () => void;
  onRetireSelected: () => void;
  onPreviewDeleteSelected: () => void;
  onSelectFiltered: () => void;
  onSelectSuccessful: () => void;
  onSelectUntested: () => void;
  onInvertFiltered: () => void;
  onClearSelection: () => void;
}

/**
 * 节点池单行工具条 —— 替代旧的 NodeOpsBar + NodeTable 内部 selection-bar。
 *
 * 布局：左统计 / 中按钮组 / 右 ⋯ dropdown。
 * 工作流从左到右：分配端口 → 测试 → 启用调度 → 发布出口池。
 */
export function NodeToolbar(props: NodeToolbarProps) {
  const hasSelection = props.selectedCount > 0;
  const canTestSelected = props.selectedWithPortCount > 0;
  const canTestAll = props.withPortCount > 0;

  return (
    <section className="node-toolbar">
      <div className="node-toolbar-stats">
        <Badge tone={hasSelection ? "info" : "neutral"}>
          已选 {props.selectedCount}/{props.totalNodes}
        </Badge>
        <span className="node-toolbar-stat muted small" title="当前筛选条件命中的节点数">
          筛选 {props.filteredCount}
        </span>
        <span className="node-toolbar-stat muted small" title="lifecycleStatus === schedulable 的节点数">
          可调度 {props.schedulableCount}
        </span>
        <div className="node-toolbar-selectors">
          <Button
            size="sm"
            variant="secondary"
            icon={<CheckSquare size={14} />}
            onClick={props.onSelectFiltered}
            title={`选中当前筛选的 ${props.filteredCount} 个节点`}
          >
            全选
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Replace size={14} />}
            onClick={props.onInvertFiltered}
            title="反转当前筛选结果的勾选状态"
          >
            反选
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Check size={14} />}
            onClick={props.onSelectSuccessful}
            title="只选中筛选结果中 status=active 的节点"
          >
            选择可用
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<CircleDashed size={14} />}
            onClick={props.onSelectUntested}
            title="只选中筛选结果中尚未测试（status=untested）的节点，便于批量测新导入的节点"
          >
            选择未测试
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<XSquare size={14} />}
            disabled={!hasSelection}
            onClick={props.onClearSelection}
            title="取消所有勾选"
          >
            清空
          </Button>
        </div>
      </div>

      <div className="node-toolbar-actions">
        <Button
          size="sm"
          icon={<Plug size={14} />}
          disabled={props.busy || !hasSelection}
          loading={props.attaching}
          onClick={props.onAttach}
          title="给所选节点分配端口并接入 Mihomo 本地监听，可以拿来测试。不改生命周期，也不会被推送到 Sub2API、不会被自动绑账号。"
        >
          分配端口
        </Button>

        <div className="button-group">
          <Button
            size="sm"
            variant="secondary"
            icon={<Activity size={14} />}
            loading={props.testing}
            disabled={props.busy || !hasSelection}
            onClick={props.onTestSelected}
            title={
              !hasSelection
                ? "请先在表格里勾选节点"
                : canTestSelected
                  ? `对所选 ${props.selectedCount} 个节点跑 OpenAI 连通性测试`
                  : "所选节点未分配端口，测试时会自动先分配端口并接入 Mihomo 再测"
            }
          >
            测试所选
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Activity size={14} />}
            loading={props.testing}
            disabled={props.busy || !canTestAll}
            onClick={props.onTestAll}
            title={
              !canTestAll
                ? "没有已分配端口的节点，先点'分配端口'"
                : `对所有 ${props.withPortCount} 个已分配端口、未退役节点跑测试`
            }
          >
            测试全部
          </Button>
        </div>

        <Button
          size="sm"
          variant="secondary"
          icon={<PlayCircle size={14} />}
          disabled={props.busy || !hasSelection}
          loading={props.enabling}
          onClick={props.onEnableSelected}
          title="把所选节点设为可调度，并在验活通过后幂等推送到 Sub2API；不会更换已有账号出口。"
        >
          启用调度
        </Button>

        <Dropdown
          align="right"
          trigger={
            <span className="node-toolbar-more" aria-label="更多操作">
              <MoreHorizontal size={16} />
            </span>
          }
        >
          <DropdownGroup label="诊断">
            <DropdownItem
              icon={<RefreshCw size={14} />}
              disabled={props.busy || props.rebuilding}
              hint="用当前节点状态强制重新渲染 mihomo.yaml 并重载进程。不动端口分配、不改生命周期、不推送到 Sub2API。用于配置文件损坏 / 进程挂掉时的兜底恢复。"
              onClick={props.onRebuildMihomo}
            >
              重建 Mihomo
            </DropdownItem>
            <DropdownItem
              icon={<RotateCcw size={14} />}
              disabled={props.busy || props.resetting || !hasSelection}
              hint="清除所选节点的退避计数和健康分，让后台重新验活；已有 Sub2API 映射会保留。"
              onClick={props.onResetIntent}
            >
              重置健康状态
            </DropdownItem>
          </DropdownGroup>
          <DropdownGroup label="生命周期（所选）">
            <DropdownItem
              icon={<PauseCircle size={14} />}
              disabled={props.busy || !hasSelection}
              hint={
                "生命周期 → 已锁定：节点被冻结。\n" +
                "已有账号绑定保持不变，不会被系统迁移。\n\n" +
                "需要主动点「启用调度」才能重新接活。保留本地记录与端口。"
              }
              onClick={props.onDisableSelected}
            >
              锁定调度
            </DropdownItem>
            <DropdownItem
              icon={<Snowflake size={14} />}
              disabled={props.busy || !hasSelection}
              hint={
                "生命周期 → 冷却中：节点有问题，暂时下线。\n" +
                "节点会暂时停止推送，后台验活恢复后可再次启用。\n\n" +
                "与退役的区别只在生命周期：冷却预期会恢复，退役表示永久下线。"
              }
              onClick={props.onCoolingDownSelected}
            >
              冷却
            </DropdownItem>
            <DropdownItem
              icon={<Archive size={14} />}
              disabled={props.busy || !hasSelection}
              hint={
                "生命周期 → 已退役：永久下线。\n" +
                "节点停止推送，端口可被回收；本地记录保留用于历史查询。"
              }
              onClick={props.onRetireSelected}
            >
              退役
            </DropdownItem>
            <DropdownItem
              icon={<Trash2 size={14} />}
              danger
              disabled={props.busy || !hasSelection}
              hint="完全删除本地节点记录；不会执行账号迁移。需要二次确认。"
              onClick={props.onPreviewDeleteSelected}
            >
              删除
            </DropdownItem>
          </DropdownGroup>
        </Dropdown>
      </div>
    </section>
  );
}

export function summarizePool(nodes: ProxyNode[]): {
  total: number;
  schedulable: number;
  withPort: number;
  exportable: number;
} {
  return {
    total: nodes.length,
    schedulable: nodes.filter((node) => node.lifecycleStatus === "schedulable").length,
    withPort: nodes.filter(
      (node) =>
        Boolean(node.assignedPort) &&
        node.lifecycleStatus !== "retired" &&
        node.lifecycleStatus !== "deleted"
    ).length,
    exportable: nodes.filter(
      (node) =>
        Boolean(node.assignedPort) &&
        node.lifecycleStatus !== "retired" &&
        node.lifecycleStatus !== "deleted"
    ).length
  };
}
