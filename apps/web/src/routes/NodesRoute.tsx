import React from "react";
import type {
  NodeDeletionPlan,
  ProxyNode,
  Sub2ApiProxyRecord,
  SubscriptionImportPreview,
  SubscriptionSource
} from "@mihomo-hive/schemas";
import { NodePoolPanel } from "../features/node-pool/NodePoolPanel.js";
import { NodeToolbar, summarizePool } from "../features/nodes/NodeToolbar.js";
import { NodeTable } from "../features/nodes/NodeTable.js";
import type { NodeFilters } from "../features/nodes/node-utils.js";
import type { ConfirmAction } from "../hooks/useConfirmAction.js";

interface PendingMutation {
  isPending: boolean;
}

interface SubscriptionSummary extends Omit<SubscriptionSource, "lastContent"> {
  fetched: boolean;
  lastContentBytes?: number;
}

export interface NodesRouteProps {
  subscriptions: SubscriptionSummary[];
  allNodes: ProxyNode[];
  filteredNodes: ProxyNode[];
  selectedHashes: Set<string>;
  selectedHashesList: string[];
  setSelectedHashesList: (next: string[]) => void;
  filters: NodeFilters;
  setFilters: (next: NodeFilters) => void;
  sourceNames: Map<string, string>;
  importPreview: SubscriptionImportPreview | undefined;
  setImportPreview: (next: SubscriptionImportPreview | undefined) => void;
  deletePlan: NodeDeletionPlan | undefined;
  setDeletePlan: (next: NodeDeletionPlan | undefined) => void;
  subscriptionName: string;
  setSubscriptionName: (v: string) => void;
  subscriptionUrl: string;
  setSubscriptionUrl: (v: string) => void;
  subscriptionKeywords: string;
  setSubscriptionKeywords: (v: string) => void;
  parseKeywords: () => string[];
  /** Sub2API 端的代理列表（按 proxy_id 索引），供节点表显示状态 + 承载账号数 */
  sub2apiProxies: Map<number, Sub2ApiProxyRecord>;
  sub2apiConnected: boolean;
  busy: boolean;
  mutateSelection: (updater: (current: Set<string>) => Set<string>) => void;
  previewSelectedDeletePlan: () => Promise<void>;
  requestConfirmation: (action: ConfirmAction) => void;
  mutations: {
    addSubscription: PendingMutation & { mutate: (input: { name: string; url: string }) => void };
    previewImport: PendingMutation & {
      mutate: (input: { id?: string; name?: string; url?: string; excludeKeywords: string[] }) => void;
    };
    applyImport: PendingMutation & {
      mutate: (input: { id?: string; name: string; url: string; excludeKeywords: string[] }) => void;
    };
    setLifecycle: PendingMutation & {
      mutate: (input: {
        hashes: string[];
        lifecycleStatus: "schedulable" | "disabled" | "cooling_down" | "retired";
      }) => void;
    };
    enableScheduling: PendingMutation & { mutate: (input: { hashes: string[] }) => void };
    deleteNodes: PendingMutation & { mutate: (input: { hashes: string[]; forceLocal: boolean }) => void };
    testNodes: PendingMutation & {
      mutate: (input: { targets: string[]; timeoutMs: number; concurrency: number; hashes?: string[] }) => void;
    };
    attachToMihomo: PendingMutation & { mutate: (input: { hashes: string[] }) => void };
    rebuildMihomo: PendingMutation & { mutate: () => void };
    resetIntent: PendingMutation & { mutate: (input: { hashes: string[]; liftFromRetired?: boolean }) => void };
    deleteSubscription: PendingMutation & { mutate: (input: { id: string }) => void };
  };
}

export function NodesRoute(props: NodesRouteProps) {
  const m = props.mutations;
  const pool = summarizePool(props.allNodes);
  const selectedNodes = React.useMemo(
    () => props.allNodes.filter((node) => props.selectedHashes.has(node.hash)),
    [props.allNodes, props.selectedHashes]
  );
  const selectedWithPortCount = selectedNodes.filter((node) => node.assignedPort).length;
  const selectedUntestedCount = selectedNodes.filter((node) => !node.lastTestStatus).length;
  const filteredCount = props.filteredNodes.length;
  return (
    <section className="workspace-grid node-pool-grid">
      <NodePoolPanel
        subscriptions={props.subscriptions}
        nodes={props.allNodes}
        busy={props.busy}
        importName={props.subscriptionName}
        importUrl={props.subscriptionUrl}
        importKeywords={props.subscriptionKeywords}
        preview={props.importPreview}
        deletePlan={props.deletePlan}
        previewing={m.previewImport.isPending}
        importing={m.applyImport.isPending}
        saving={m.addSubscription.isPending}
        onImportNameChange={props.setSubscriptionName}
        onImportUrlChange={props.setSubscriptionUrl}
        onImportKeywordsChange={props.setSubscriptionKeywords}
        onSaveSubscription={() =>
          m.addSubscription.mutate({ name: props.subscriptionName, url: props.subscriptionUrl })
        }
        onPreviewImport={(source) => {
          if (source) {
            props.setSubscriptionName(source.name);
            props.setSubscriptionKeywords(source.excludeKeywords.join(","));
            m.previewImport.mutate({ id: source.id, excludeKeywords: source.excludeKeywords });
          } else {
            m.previewImport.mutate({
              name: props.subscriptionName,
              url: props.subscriptionUrl,
              excludeKeywords: props.parseKeywords()
            });
          }
        }}
        onRepreviewWithKeywords={(keywords) => {
          props.setSubscriptionKeywords(keywords.join(","));
          const id = props.importPreview?.source.id;
          const name = props.importPreview?.source.name ?? props.subscriptionName;
          const url = props.importPreview?.source.value ?? props.subscriptionUrl;
          // 同时带 id + name + url：后端优先用已保存的 id，找不到(未保存的预览源)则回退到
          // url，避免"重新预览"报"订阅源不存在"。
          m.previewImport.mutate({
            ...(id ? { id } : {}),
            ...(name ? { name } : {}),
            ...(url ? { url } : {}),
            excludeKeywords: keywords
          });
        }}
        onApplyImport={(keywords) => {
          props.setSubscriptionKeywords(keywords.join(","));
          const previewSourceId = props.importPreview?.source.id;
          m.applyImport.mutate({
            ...(previewSourceId ? { id: previewSourceId } : {}),
            name: props.importPreview?.source.name ?? props.subscriptionName,
            url: props.importPreview?.source.value ?? props.subscriptionUrl,
            excludeKeywords: keywords
          });
        }}
        onClearPreview={() => props.setImportPreview(undefined)}
        onApplyDeleteSelected={(forceLocal) => {
          if (forceLocal) {
            m.deleteNodes.mutate({ hashes: props.selectedHashesList, forceLocal: true });
          } else {
            props.setDeletePlan(undefined);
          }
        }}
        onDeleteSubscription={(id) =>
          props.requestConfirmation({
            title: "确认删除订阅",
            description: "会删除订阅源以及由它导入的本地节点。",
            detail: "如果这些节点已经在 Sub2API 中被账号使用，请先通过节点删除计划排空账号绑定。",
            confirmLabel: "删除订阅",
            dangerous: true,
            run: async () => m.deleteSubscription.mutate({ id })
          })
        }
      />
      <div className="nodes-stack">
        <NodeToolbar
          totalNodes={pool.total}
          filteredCount={filteredCount}
          schedulableCount={pool.schedulable}
          selectedCount={props.selectedHashes.size}
          selectedWithPortCount={selectedWithPortCount}
          selectedUntestedCount={selectedUntestedCount}
          withPortCount={pool.withPort}
          busy={props.busy}
          attaching={m.attachToMihomo.isPending}
          testing={m.testNodes.isPending}
          enabling={m.enableScheduling.isPending}
          rebuilding={m.rebuildMihomo.isPending}
          resetting={m.resetIntent.isPending}
          onAttach={() => m.attachToMihomo.mutate({ hashes: props.selectedHashesList })}
          onTestSelected={() =>
            m.testNodes.mutate({
              targets: ["openai"],
              timeoutMs: 15_000,
              concurrency: 8,
              hashes: props.selectedHashesList
            })
          }
          onTestAll={() =>
            m.testNodes.mutate({ targets: ["openai"], timeoutMs: 15_000, concurrency: 8 })
          }
          onEnableSelected={() => {
            const total = selectedNodes.length;
            const untested = selectedUntestedCount;
            const withoutPort = total - selectedWithPortCount;
            const description =
              untested > 0
                ? `${untested}/${total} 个所选节点还没测试过。启用调度后系统会立即幂等推送到 Sub2API。建议先"分配端口"+"测试所选"，确认可用后再启用。`
                : withoutPort > 0
                  ? `${withoutPort}/${total} 个所选节点没有分配端口。这些节点会被标记为"可调度"但不会被推送（Sub2API 只接收可用+已分端口的代理）。`
                  : `${total} 个所选节点都测试过且有端口，会一并推送到 Sub2API。`;
            props.requestConfirmation({
              title: "确认启用调度",
              description,
              detail:
                "启用调度会把节点标记为可调度、幂等推送到 Sub2API 并回填代理 ID。系统不会改变已有账号代理绑定。可在下拉菜单里随时锁定调度。",
              confirmLabel: "启用调度",
              run: async () => m.enableScheduling.mutate({ hashes: props.selectedHashesList })
            });
          }}
          onRebuildMihomo={() =>
            props.requestConfirmation({
              title: "确认重建 Mihomo",
              description:
                "用当前节点状态强制重新渲染 Mihomo 配置并重载进程。不动端口分配、不改生命周期、不会推送到 Sub2API。",
              detail:
                "用途：配置文件被外部改坏 / Mihomo 进程异常退出需要拉起 / 手动校验配置。重载期间已建立的代理连接可能短暂中断。",
              confirmLabel: "重建",
              run: async () => m.rebuildMihomo.mutate()
            })
          }
          onResetIntent={() => {
            const evictedCount = selectedNodes.filter((n) => n.intentRole === "evicted").length;
            const quarantinedCount = selectedNodes.filter((n) => n.intentRole === "quarantined").length;
            const retiredCount = selectedNodes.filter((n) => n.lifecycleStatus === "retired").length;
            const withSub2api = selectedNodes.filter((n) => n.sub2apiProxyId).length;
            const total = selectedNodes.length;
            props.requestConfirmation({
              title: "重置节点健康状态",
              description:
                `${total} 个所选节点将被重置：${evictedCount} 个已驱逐 / ${quarantinedCount} 个退避中 / ${retiredCount} 个已退役。` +
                ` 其中 ${withSub2api} 个节点已有 Sub2API 映射，映射会保留以避免账号出口变化。`,
              detail:
                "重置内容：后台健康意图 / 退避计数 / 健康分。" +
                " 如果含已退役节点，会同时把生命周期改回可调度。" +
                " 后续标准动作：① 工具栏【分配端口】重新分配 → ② 【启用调度】重新推送 Sub2API。" +
                " 后台会在下一轮同步时保留现有账号绑定，不执行账号迁移。",
              confirmLabel: "重置",
              run: async () => m.resetIntent.mutate({ hashes: props.selectedHashesList, liftFromRetired: true })
            });
          }}
          onDisableSelected={() =>
            m.setLifecycle.mutate({ hashes: props.selectedHashesList, lifecycleStatus: "disabled" })
          }
          onCoolingDownSelected={() =>
            m.setLifecycle.mutate({ hashes: props.selectedHashesList, lifecycleStatus: "cooling_down" })
          }
          onRetireSelected={() =>
            m.setLifecycle.mutate({ hashes: props.selectedHashesList, lifecycleStatus: "retired" })
          }
          onPreviewDeleteSelected={props.previewSelectedDeletePlan}
          onSelectFiltered={() =>
            props.mutateSelection((current) => {
              for (const node of props.filteredNodes) current.add(node.hash);
              return current;
            })
          }
          onSelectSuccessful={() =>
            props.mutateSelection((current) => {
              for (const node of props.filteredNodes) {
                if (node.status === "active") current.add(node.hash);
              }
              return current;
            })
          }
          onSelectUntested={() =>
            props.mutateSelection((current) => {
              for (const node of props.filteredNodes) {
                if (node.status === "untested") current.add(node.hash);
              }
              return current;
            })
          }
          onInvertFiltered={() =>
            props.mutateSelection((current) => {
              for (const node of props.filteredNodes) {
                if (current.has(node.hash)) current.delete(node.hash);
                else current.add(node.hash);
              }
              return current;
            })
          }
          onClearSelection={() => props.setSelectedHashesList([])}
        />
        <NodeTable
          nodes={props.allNodes}
          filteredNodes={props.filteredNodes}
          filters={props.filters}
          sourceNames={props.sourceNames}
          selectedHashes={props.selectedHashes}
          sub2apiProxies={props.sub2apiProxies}
          sub2apiConnected={props.sub2apiConnected}
          onFiltersChange={props.setFilters}
          onToggleNode={(hash, selected) =>
            props.mutateSelection((current) => {
              if (selected) current.add(hash);
              else current.delete(hash);
              return current;
            })
          }
        />
      </div>
    </section>
  );
}
