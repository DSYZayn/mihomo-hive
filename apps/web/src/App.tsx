import React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ConfirmDialog, ToastStack, type ToastMessage } from "./components/ui.js";
import { AuthScreen } from "./features/auth/AuthScreen.js";
import { canExportNode, defaultNodeFilters, filterNodes, type NodeFilters } from "./features/nodes/node-utils.js";
import { RuntimeHeader } from "./features/runtime/RuntimeHeader.js";
import { SystemRoute } from "./routes/SystemRoute.js";
import { NodesRoute } from "./routes/NodesRoute.js";
import { useTaskFeedback, type TaskFeedback } from "./hooks/useTaskFeedback.js";
import { useConfirmAction, type ConfirmAction } from "./hooks/useConfirmAction.js";
import { useTheme } from "./hooks/useTheme.js";
import { fetchAuthStatus, logout, type AuthStatus } from "./lib/auth.js";
import { useLocalStorageState } from "./lib/persistence.js";
import { queryClient, trpc, trpcClient } from "./lib/trpc.js";
import type { NodeDeletionPlan, Sub2ApiProxyRecord, SubscriptionImportPreview } from "@mihomo-hive/schemas";

export function AppRoot() {
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

function App() {
  const utils = trpc.useUtils();
  const [authStatus, setAuthStatus] = React.useState<AuthStatus | undefined>();
  const authenticated = Boolean(authStatus?.authenticated);

  const refreshAuth = React.useCallback(async () => {
    setAuthStatus(await fetchAuthStatus());
  }, []);

  React.useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

  async function handleAuthenticated() {
    await refreshAuth();
    await utils.invalidate();
  }

  async function handleLogout() {
    await logout();
    queryClient.clear();
    await refreshAuth();
  }

  if (!authStatus || !authenticated) {
    return <AuthScreen status={authStatus} onAuthenticated={handleAuthenticated} />;
  }

  return <Dashboard onLogout={handleLogout} />;
}

function Dashboard(props: { onLogout: () => void }) {
  const utils = trpc.useUtils();
  // 配置类 query 用 staleTime: Infinity 永不过期，只在 mutation invalidate 时才更新。
  // 这些数据"用户改了才会变"，不需要任何周期刷新；之前 staleTime=0 + 组件重挂载导致
  // 每次切 tab 都重 fetch、data 短暂 undefined 让 UI 误判"未配置"。
  const config = trpc.runtime.config.useQuery(undefined, { staleTime: Infinity });
  const runtimeStatus = trpc.runtime.status.useQuery(undefined, {
    refetchInterval: 2_000,
    refetchOnReconnect: true,
    refetchOnMount: "always"
  });
  const subscriptions = trpc.subscriptions.list.useQuery(undefined, {
    refetchInterval: 2_000,
    refetchOnReconnect: true,
    refetchOnMount: "always"
  });
  const sub2apiConfig = trpc.sub2api.config.get.useQuery(undefined, { staleTime: Infinity });

  const [subscriptionName, setSubscriptionName] = React.useState("");
  const [subscriptionUrl, setSubscriptionUrl] = React.useState("");
  const [subscriptionKeywords, setSubscriptionKeywords] = React.useState("");
  const [exportHost, setExportHost] = React.useState("127.0.0.1");
  const [exportFilename, setExportFilename] = React.useState("sub2api-proxies.json");
  const [failedNodeStatus, setFailedNodeStatus] = React.useState<"active" | "inactive">("inactive");
  const [sub2apiBaseUrl, setSub2apiBaseUrl] = React.useState("");
  const [sub2apiApiKey, setSub2apiApiKey] = React.useState("");
  const [sub2apiTimezone, setSub2apiTimezone] = React.useState("Asia/Shanghai");
  const [sub2apiManagedPrefix, setSub2apiManagedPrefix] = React.useState("MH-");
  const [workspaceRaw, setWorkspace] = useLocalStorageState<"nodes" | "system" | "automation" | "account_fleet">(
    "mihomo-hive.workspace",
    "nodes"
  );
  // 兼容旧 localStorage 值：历史的代理/账号编排入口统一回到设置页。
  const workspace: "nodes" | "system" =
    workspaceRaw === "nodes" ? "nodes" : "system";
  // 节点池页 30s 自动刷新：后台编排器会更新 sub2apiProxyId / qualityScore / intentRole 等字段，
  // 不刷的话表格内容会跟实际状态脱节。
  const nodes = trpc.nodes.list.useQuery(undefined, {
    // 节点验活/自动推送在后台进行，短轮询保证操作结果无需手动刷新页面即可出现。
    refetchInterval: 2_000,
    refetchOnReconnect: true,
    refetchOnMount: "always"
  });
  const [filters, setFilters] = useLocalStorageState<NodeFilters>("mihomo-hive.node-filters", defaultNodeFilters);
  const [selectedHashesList, setSelectedHashesList] = useLocalStorageState<string[]>("mihomo-hive.selected-hashes", []);
  const selectedHashes = React.useMemo(() => new Set(selectedHashesList), [selectedHashesList]);
  const feedback = useTaskFeedback();
  const { task, setTask, toasts, pushToast, dismissToast } = feedback;
  const confirm = useConfirmAction();
  const confirmAction = confirm.current;
  const theme = useTheme();
  const [downloading, setDownloading] = React.useState(false);
  const [importPreview, setImportPreview] = React.useState<SubscriptionImportPreview | undefined>();
  const [deletePlan, setDeletePlan] = React.useState<NodeDeletionPlan | undefined>();

  React.useEffect(() => {
    if (config.data) {
      setExportHost(config.data.exportHost);
    }
  }, [config.data]);

  React.useEffect(() => {
    if (sub2apiConfig.data?.baseUrl) {
      setSub2apiBaseUrl(sub2apiConfig.data.baseUrl);
      setSub2apiTimezone(sub2apiConfig.data.timezone ?? "Asia/Shanghai");
      setSub2apiManagedPrefix(sub2apiConfig.data.managedProxyPrefix ?? "MH-");
    }
  }, [sub2apiConfig.data]);

  const allNodes = nodes.data ?? [];
  React.useEffect(() => {
    const known = new Set(allNodes.map((node) => node.hash));
    setSelectedHashesList((current) => {
      const next = current.filter((hash) => known.has(hash));
      return next.length === current.length ? current : next;
    });
  }, [allNodes, setSelectedHashesList]);
  const filteredNodes = React.useMemo(() => filterNodes(allNodes, filters), [allNodes, filters]);
  const activeCount = allNodes.filter((node) => node.status === "active").length;
  const assignedCount = allNodes.filter((node) => node.assignedPort).length;
  const exportableSelectedCount = allNodes.filter((node) => selectedHashes.has(node.hash) && canExportNode(node)).length;
  const sourceNames = React.useMemo(
    () => {
      const map = new Map((subscriptions.data ?? []).map((source) => [source.id, source.name] as const));
      map.set("__hive_chain__", "链式代理");
      return map;
    },
    [subscriptions.data]
  );

  const exportPreview = trpc.exports.previewSub2api.useQuery(
    {
      selectedHashes: selectedHashesList,
      host: exportHost,
      filename: exportFilename,
      failedNodeStatus
    },
    { enabled: selectedHashesList.length > 0 }
  );
  const sub2apiProxies = trpc.sub2api.proxies.list.useQuery(undefined, {
    enabled: Boolean(sub2apiConfig.data?.configured),
    // 节点池表显示 account_count 实时变化；编排器 30s 一个 tick，对齐刷新节奏
    refetchInterval: 2_000,
    refetchOnReconnect: true,
    refetchOnMount: "always"
  });
  const sub2apiProxiesById = React.useMemo<Map<number, Sub2ApiProxyRecord>>(() => {
    const map = new Map<number, Sub2ApiProxyRecord>();
    if (sub2apiProxies.data) {
      for (const proxy of sub2apiProxies.data) map.set(proxy.id, proxy);
    }
    return map;
  }, [sub2apiProxies.data]);
  const refreshOperationalData = React.useCallback(async () => {
    // 直接 refetch 当前活动 query，而不是只标记 stale。这样 mutation 完成后
    // 即使 query 的 staleTime 为 Infinity，也会立刻把最新服务端状态画出来。
    const refreshes: Promise<unknown>[] = [
      subscriptions.refetch(),
      nodes.refetch(),
      runtimeStatus.refetch(),
      sub2apiConfig.refetch(),
      utils.exports.previewSub2api.invalidate()
    ];
    if (sub2apiConfig.data?.configured) {
      refreshes.push(sub2apiProxies.refetch());
    }
    await Promise.all(refreshes);
  }, [nodes, runtimeStatus, sub2apiConfig, sub2apiProxies, subscriptions, utils]);

  const addSubscription = trpc.subscriptions.add.useMutation({
    onMutate: () => startTask(setTask, "正在添加订阅", "保存订阅源，稍后可继续拉取节点。"),
    onSuccess: async () => {
      setSubscriptionName("");
      setSubscriptionUrl("");
      await finishTask(setTask, pushToast, "订阅已添加", "可以继续拉取订阅内容。");
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "订阅添加失败", error.message)
  });
  const previewImport = trpc.subscriptions.previewImport.useMutation({
    onMutate: () => startTask(setTask, "正在拉取并预览订阅", "系统会先展示将导入、过滤和重复的节点。"),
    onSuccess: async (result) => {
      setImportPreview(result);
      await finishTask(setTask, pushToast, "订阅预览完成", `解析 ${result.summary.total} 个节点，可导入 ${result.summary.importable} 个。`);
    },
    onError: (error) => failTask(setTask, pushToast, "订阅预览失败", error.message)
  });
  const applyImportPreview = trpc.subscriptions.applyImport.useMutation({
    onMutate: () => startTask(setTask, "正在导入预览结果", "只会导入预览中标记为导入或更新的节点。"),
    onSuccess: async (result) => {
      setImportPreview(undefined);
      await finishTask(setTask, pushToast, "节点已重新导入", `导入或更新 ${result.imported} 个节点，按过滤规则删除 ${result.deletedByFilter} 个旧节点。`);
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "节点导入失败", error.message)
  });
  const deleteSubscription = trpc.subscriptions.delete.useMutation({
    onMutate: () => startTask(setTask, "正在删除订阅", "会同时删除该订阅导入的节点。"),
    onSuccess: async () => {
      await finishTask(setTask, pushToast, "订阅已删除", "关联节点已从本地数据库移除。");
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "订阅删除失败", error.message)
  });
  const setNodeLifecycle = trpc.nodes.setLifecycle.useMutation({
    onMutate: () => startTask(setTask, "正在更新节点调度状态", "系统会调整所选节点的生命周期状态。"),
    onSuccess: async (result) => {
      await finishTask(setTask, pushToast, "节点调度状态已更新", `更新 ${result.updated} 个节点。`);
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "节点调度状态更新失败", error.message)
  });
  const deleteNodes = trpc.nodes.applyDelete.useMutation({
    onMutate: () => startTask(setTask, "正在删除节点", "删除前会校验 Sub2API 账号依赖。"),
    onSuccess: async (result) => {
      setDeletePlan(undefined);
      mutateSelection(() => new Set());
      await finishTask(setTask, pushToast, "节点已删除", `删除 ${result.deleted} 个节点。`);
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "节点删除失败", error.message)
  });
  const testNodes = trpc.nodes.test.useMutation({
    onMutate: () => startTask(setTask, "正在批量测试", "正在使用 OpenAI 目标检查本地 listener 可用性。"),
    onSuccess: async (result) => {
      const tone = result.failed > 0 ? "warning" : "success";
      setTask({
        state: result.failed > 0 ? "success" : "success",
        title: "批量测试完成",
        detail: `测试 ${result.tested} 个节点，通过 ${result.passed} 个，失败 ${result.failed} 个。`
      });
      pushToast(tone, "批量测试完成", `通过 ${result.passed}/${result.tested}。`);
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "批量测试失败", error.message)
  });
  const rebuildMihomo = trpc.runtime.publish.useMutation({
    onMutate: () =>
      startTask(setTask, "正在重建 Mihomo", "用当前节点状态重新渲染 Mihomo 配置并重载进程；不动端口、不推送 Sub2API。"),
    onSuccess: async (result) => {
      await finishTask(setTask, pushToast, "Mihomo 已重建", `当前 ${result.listeners} 个 listener。`);
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "重建 Mihomo 失败", error.message)
  });
  const resetIntent = trpc.nodes.resetIntent.useMutation({
    onMutate: () =>
      startTask(
        setTask,
        "正在重置节点健康状态",
        "清掉所选节点的退避计数、健康分和旧代理映射，让后台验活重新评估。"
      ),
    onSuccess: async (result) => {
      const liftMsg = result.liftedFromRetired > 0 ? `，${result.liftedFromRetired} 个从已退役状态恢复` : "";
      await finishTask(
        setTask,
        pushToast,
        "节点健康状态已重置",
        `${result.reset} 个节点已重置${liftMsg}。后台会在下一轮验活后更新状态并幂等同步健康节点。`
      );
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "重置编排状态失败", error.message)
  });
  const attachToMihomo = trpc.nodes.attachToMihomo.useMutation({
    onMutate: () =>
      startTask(setTask, "正在接入 Mihomo", "给所选节点分配端口并刷新 Mihomo 本地监听；不会推送到 Sub2API。"),
    onSuccess: async (result) => {
      await finishTask(
        setTask,
        pushToast,
        "节点已接入 Mihomo",
        `分配 ${result.assigned} 个端口，当前共 ${result.listeners} 个 listener。可以点'测试所选'验证连通性。`
      );
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "接入 Mihomo 失败", error.message)
  });
  const enableScheduling = trpc.nodes.enableScheduling.useMutation({
    onMutate: () =>
      startTask(setTask, "正在启用调度", "把所选节点设为可调度，并推送到 Sub2API 代理池。"),
    onSuccess: async (result) => {
      if (result.syncedToSub2api && result.summary) {
        await finishTask(
          setTask,
          pushToast,
          "调度已启用",
          `${result.updated} 个节点纳入调度。Sub2API：新增 ${result.summary.proxy_created}，复用 ${result.summary.proxy_reused}，失败 ${result.summary.proxy_failed}。`
        );
      } else if (result.reason === "no-connection") {
        await finishTask(
          setTask,
          pushToast,
          "调度已启用（未推送）",
          `${result.updated} 个节点标记为可调度，但 Sub2API 未连接。请先在设置与工具页配置连接，再到节点池重新启用以触发推送。`
        );
      } else {
        await finishTask(
          setTask,
          pushToast,
          "调度已启用（未推送）",
          `${result.updated} 个节点标记为可调度，但没有可用且已分端口的节点可推送。请先"分配端口"并测试通过。`
        );
      }
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "启用调度失败", error.message)
  });
  const createChain = trpc.nodes.createChain.useMutation({
    onMutate: () => startTask(setTask, "正在创建链式节点", "生成两跳 Mihomo 节点、分配端口并重载配置。"),
    onSuccess: async (result) => {
      await finishTask(
        setTask,
        pushToast,
        result.created ? "链式节点已创建" : "链式节点已存在",
        result.node ? `${result.node.name} · 端口 ${result.node.assignedPort ?? "-"}` : "已复用现有链式节点。"
      );
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "链式节点创建失败", error.message)
  });
  const startMihomo = trpc.mihomo.start.useMutation({
    onMutate: () => startTask(setTask, "正在启动 Mihomo", "服务会在后台保持运行。"),
    onSuccess: async (result) => {
      await finishTask(setTask, pushToast, result.running ? "Mihomo 已运行" : "Mihomo 未运行", result.pid ? `PID ${result.pid}` : "未获取到 PID。");
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "Mihomo 启动失败", error.message)
  });
  const reloadMihomo = trpc.mihomo.reload.useMutation({
    onMutate: () => startTask(setTask, "正在重载 Mihomo", "会向当前 Mihomo 进程发送重载信号。"),
    onSuccess: async () => {
      await finishTask(setTask, pushToast, "Mihomo 已重载", "配置变更已提交给运行进程。");
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "Mihomo 重载失败", error.message)
  });
  const stopMihomo = trpc.mihomo.stop.useMutation({
    onMutate: () => startTask(setTask, "正在停止 Mihomo", "正在停止后台 Mihomo 进程。"),
    onSuccess: async () => {
      await finishTask(setTask, pushToast, "Mihomo 已停止", "本地出口 listener 已关闭。");
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "Mihomo 停止失败", error.message)
  });
  const writeExport = trpc.exports.writeSub2api.useMutation({
    onMutate: () => startTask(setTask, "正在写入 Sub2API JSON", `将 ${exportableSelectedCount} 个可导出节点写入服务器文件。`),
    onSuccess: async (result) => {
      await finishTask(setTask, pushToast, "Sub2API JSON 已写入", `${result.proxies} 个代理已写入 ${result.output}。`);
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "Sub2API 写入失败", error.message)
  });
  const saveSub2apiConfig = trpc.sub2api.config.save.useMutation({
    onMutate: () => startTask(setTask, "正在保存 Sub2API 配置", "API Key 只会保存在服务端，不会回显到前端。"),
    onSuccess: async () => {
      setSub2apiApiKey("");
      await finishTask(setTask, pushToast, "Sub2API 配置已保存", "可以继续测试连接并拉取代理与账号。");
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "Sub2API 配置保存失败", error.message)
  });
  const testSub2apiConnection = trpc.sub2api.config.test.useMutation({
    onMutate: () => startTask(setTask, "正在测试 Sub2API 连接", "使用 x-api-key 拉取代理与账号摘要。"),
    onSuccess: async (result) => {
      await finishTask(setTask, pushToast, "Sub2API 连接正常", `代理 ${result.proxies} 个，账号 ${result.accounts} 个。`);
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "Sub2API 连接失败", error.message)
  });
  const pushManagedSub2api = trpc.sub2api.automation.syncManagedProxies.useMutation({
    onMutate: () =>
      startTask(setTask, "正在推送本地节点到 Sub2API", "把 Hive 节点上行同步并回填代理 ID。"),
    onSuccess: async (result) => {
      await finishTask(
        setTask,
        pushToast,
        "本地节点已推送 Sub2API",
        `新增 ${result.summary.proxy_created}，复用 ${result.summary.proxy_reused}，失败 ${result.summary.proxy_failed}；映射 ${result.mappedNodes} 个本地节点。`
      );
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "上行同步失败", error.message)
  });
  const qualityCheckManaged = trpc.sub2api.automation.qualityCheckManaged.useMutation({
    onMutate: () =>
      startTask(setTask, "正在对 Hive 托管代理执行质量检查", "对每个托管代理调用 quality-check 并回填分数。"),
    onSuccess: async (result) => {
      await finishTask(
        setTask,
        pushToast,
        "质量检查完成",
        `${result.passed}/${result.total} 通过；更新 ${result.updatedLocalNodes} 个本地节点的 qualityScore。`
      );
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "质量检查失败", error.message)
  });
  const busy =
    addSubscription.isPending ||
    previewImport.isPending ||
    applyImportPreview.isPending ||
    setNodeLifecycle.isPending ||
    deleteNodes.isPending ||
    deleteSubscription.isPending ||
    testNodes.isPending ||
    rebuildMihomo.isPending ||
    attachToMihomo.isPending ||
    enableScheduling.isPending ||
    createChain.isPending ||
    resetIntent.isPending ||
    startMihomo.isPending ||
    reloadMihomo.isPending ||
    stopMihomo.isPending ||
    writeExport.isPending ||
    saveSub2apiConfig.isPending ||
    testSub2apiConnection.isPending ||
    pushManagedSub2api.isPending ||
    qualityCheckManaged.isPending ||
    downloading;

  function mutateSelection(updater: (current: Set<string>) => Set<string>) {
    setSelectedHashesList((current) => Array.from(updater(new Set(current))));
  }

  const requestConfirmation = confirm.request;

  function keywordList() {
    return subscriptionKeywords
      .split(/[,，\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  async function previewSelectedDeletePlan() {
    if (selectedHashesList.length === 0) {
      return;
    }
    startTask(setTask, "正在生成删除计划", "系统会检查 Sub2API 中是否仍有账号使用这些代理。");
    try {
      const plan = await utils.nodes.previewDelete.fetch({ hashes: selectedHashesList });
      setDeletePlan(plan);
      setTask({ state: "success", title: "删除计划已生成", detail: plan.message });
    } catch (error) {
      failTask(setTask, pushToast, "删除计划生成失败", error instanceof Error ? error.message : "未知错误");
    }
  }

  const runConfirmedAction = confirm.resolve;

  async function downloadExport() {
    setDownloading(true);
    startTask(setTask, "正在准备下载", `将下载 ${exportableSelectedCount} 个可导出节点。`);
    try {
      const response = await fetch("/api/exports/sub2api/download", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          selectedHashes: selectedHashesList,
          host: exportHost,
          filename: exportFilename,
          failedNodeStatus
        })
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = exportFilename.endsWith(".json") ? exportFilename : `${exportFilename}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      await finishTask(setTask, pushToast, "下载已触发", `浏览器正在下载 ${link.download}。`);
    } catch (error) {
      failTask(setTask, pushToast, "下载失败", error instanceof Error ? error.message : "未知错误");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <main className="app-shell">
      <RuntimeHeader
        running={Boolean(runtimeStatus.data?.running)}
        expectedListeners={runtimeStatus.data?.expectedListeners}
        reachableListeners={runtimeStatus.data?.reachableListeners}
        nodes={allNodes.length}
        active={activeCount}
        assigned={assignedCount}
        workspace={workspace}
        theme={theme.theme}
        onWorkspaceChange={(next) => setWorkspace(next)}
        onThemeChange={theme.setTheme}
        onLogout={props.onLogout}
      />

      {workspace === "nodes" ? (
        <NodesRoute
          subscriptions={subscriptions.data ?? []}
          allNodes={allNodes}
          filteredNodes={filteredNodes}
          selectedHashes={selectedHashes}
          selectedHashesList={selectedHashesList}
          setSelectedHashesList={setSelectedHashesList}
          filters={filters}
          setFilters={setFilters}
          sourceNames={sourceNames}
          importPreview={importPreview}
          setImportPreview={setImportPreview}
          deletePlan={deletePlan}
          setDeletePlan={setDeletePlan}
          subscriptionName={subscriptionName}
          setSubscriptionName={setSubscriptionName}
          subscriptionUrl={subscriptionUrl}
          setSubscriptionUrl={setSubscriptionUrl}
          subscriptionKeywords={subscriptionKeywords}
          setSubscriptionKeywords={setSubscriptionKeywords}
          parseKeywords={keywordList}
          sub2apiProxies={sub2apiProxiesById}
          sub2apiConnected={Boolean(sub2apiConfig.data?.configured)}
          busy={busy}
          mutateSelection={mutateSelection}
          previewSelectedDeletePlan={previewSelectedDeletePlan}
          requestConfirmation={requestConfirmation}
          mutations={{
            addSubscription,
            previewImport,
            applyImport: applyImportPreview,
            setLifecycle: setNodeLifecycle,
            enableScheduling,
            deleteNodes,
            testNodes,
            attachToMihomo,
            rebuildMihomo,
            resetIntent,
            deleteSubscription,
            createChain
          }}
        />
      ) : null}

      {workspace === "system" ? (
        <SystemRoute
          sub2apiConnection={sub2apiConfig.data}
          sub2apiConnectionDraft={{
            baseUrl: sub2apiBaseUrl,
            apiKey: sub2apiApiKey,
            timezone: sub2apiTimezone,
            managedPrefix: sub2apiManagedPrefix
          }}
          setSub2apiConnectionDraft={(draft) => {
            setSub2apiBaseUrl(draft.baseUrl);
            setSub2apiApiKey(draft.apiKey);
            setSub2apiTimezone(draft.timezone);
            setSub2apiManagedPrefix(draft.managedPrefix);
          }}
          managedProxyCount={
            sub2apiProxies.data?.filter((proxy) =>
              proxy.name.startsWith(sub2apiConfig.data?.managedProxyPrefix ?? "MH-")
            ).length ?? 0
          }
          exportHost={exportHost}
          exportFilename={exportFilename}
          failedNodeStatus={failedNodeStatus}
          selectedCount={selectedHashes.size}
          exportableSelectedCount={exportableSelectedCount}
          selectedHashesList={selectedHashesList}
          exportPreview={exportPreview.data}
          exportPreviewFetching={exportPreview.isFetching}
          downloading={downloading}
          setExportHost={setExportHost}
          setExportFilename={setExportFilename}
          setFailedNodeStatus={setFailedNodeStatus}
          onDownload={downloadExport}
          requestConfirmation={requestConfirmation}
          mutations={{
            saveSub2apiConnection: saveSub2apiConfig,
            testSub2apiConnection: testSub2apiConnection,
            pushLocalNodes: pushManagedSub2api,
            qualityCheck: qualityCheckManaged,
            writeExport
          }}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(confirmAction)}
        title={confirmAction?.title ?? ""}
        description={confirmAction?.description ?? ""}
        detail={confirmAction?.detail}
        confirmLabel={confirmAction?.confirmLabel ?? "确认"}
        dangerous={confirmAction?.dangerous}
        loading={busy}
        onCancel={confirm.cancel}
        onConfirm={runConfirmedAction}
      />
      <ToastStack messages={toasts} onDismiss={dismissToast} />
    </main>
  );
}

function startTask(setTask: React.Dispatch<React.SetStateAction<TaskFeedback>>, title: string, detail: string) {
  setTask({ state: "pending", title, detail, startedAt: Date.now() });
}

async function finishTask(
  setTask: React.Dispatch<React.SetStateAction<TaskFeedback>>,
  pushToast: (tone: ToastMessage["tone"], title: string, detail?: string) => void,
  title: string,
  detail: string
) {
  setTask({ state: "success", title, detail });
  pushToast("success", title, detail);
}

function failTask(
  setTask: React.Dispatch<React.SetStateAction<TaskFeedback>>,
  pushToast: (tone: ToastMessage["tone"], title: string, detail?: string) => void,
  title: string,
  detail: string
) {
  setTask({ state: "error", title, detail, technical: detail });
  pushToast("danger", title, detail);
}
