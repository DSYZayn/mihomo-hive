import { initTRPC } from "@trpc/server";
import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  assignStablePorts,
  buildNodeDeletionPlan,
  buildSubscriptionImportPreview,
  CodexAdoptionParseError,
  createSub2ApiClient,
  enumeratePorts,
  filterPreviewImportableNodes,
  filteredExistingNodeHashes,
  findOccupiedPorts,
  groupAssignmentChangesByProxy,
  isManagedProxy,
  mapLocalNodesToSub2ApiProxies,
  parseCodexAccountListEnvelope,
  planCodexToolAdoption,
  planStrategySwitch,
  validateIntakeAgainstSpec,
  mapWithConcurrency,
  parsePortRange,
  planSub2ApiAssignments,
  planSub2ApiManagedMaintenance,
  renderMihomoConfig,
  measureProxyTcpLatency,
  resolveProxyTestTargets,
  testProxyTarget
} from "@mihomo-hive/core";
import { exportSub2Api, previewSub2ApiExport } from "@mihomo-hive/exporters";
import { readMihomoStatus, reloadMihomo, startMihomo, stopMihomo } from "@mihomo-hive/mihomo";
import {
  accountFleetSpecSchema,
  accountFleetStatusSnapshotSchema,
  accountFleetTickSchema,
  defaultAccountFleetSpec,
  nodeDeletionPlanSchema,
  orchestrationSpecSchema,
  sub2ApiAccountFiltersSchema,
  sub2ApiAssignmentApplyResultSchema,
  sub2ApiAssignmentOptionsSchema,
  sub2ApiConnectionConfigSchema,
  sub2ApiExportRequestSchema,
  sub2ApiProtectedProxyRuleSchema
} from "@mihomo-hive/schemas";
import type { HiveRepository } from "@mihomo-hive/db";
import { buildCodexToolAdapter, safeLoadCrypto } from "./account-fleet-worker.js";
import { codexEgressRenderOpts } from "./codex-egress.js";
import { getJobLog } from "./job-log-buffer.js";
import type {
  AccountFleetSpec,
  AccountFleetStatusSnapshot,
  AccountFleetTick,
  AccountRecordView,
  NodeDeletionPlan,
  OperationJob,
  OperationJobStatus,
  ProxyNode,
  ReconcileTick,
  RuntimeConfig,
  Sub2ApiAccountRecord,
  Sub2ApiProtectedProxyRule,
  Sub2ApiProxyRecord,
  SubscriptionSource
} from "@mihomo-hive/schemas";

export interface RouterContext {
  config: RuntimeConfig;
  repo: HiveRepository;
  authenticated: boolean;
  orchestrator?: { triggerNow: () => Promise<ReconcileTick> } | undefined;
  accountFleetScheduler?: { triggerNow: () => Promise<AccountFleetTick> } | undefined;
  accountJobsWorker?: { pump: () => Promise<void> } | undefined;
}

const t = initTRPC.context<RouterContext>().create();
const operationJobs = new Map<string, OperationJob>();

const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.authenticated) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next();
});

export const appRouter = t.router({
  runtime: t.router({
    config: protectedProcedure.query(({ ctx }) => ctx.config),
    status: protectedProcedure.query(async ({ ctx }) => readMihomoStatus(ctx.config)),
    /**
     * 紧急重建：基于当前 DB 状态重新渲染 mihomo.yaml + 启动/reload 进程。
     *
     * 不动端口分配 / 不改 lifecycle / 不推 Sub2API —— 仅诊断兜底用。
     * 适用场景：mihomo.yaml 被外部改坏 / 进程异常退出 / 启动失败需要强制 reload。
     *
     * （历史名"runtime.publish"保留以避免前端老调用方编译失败；语义已改）
     */
    publish: protectedProcedure.mutation(async ({ ctx }) => {
      const job = createJob("runtime.publish", "正在重建 Mihomo", "用当前节点状态重新渲染配置并 reload 进程。", [
        "渲染配置",
        "应用进程"
      ]);
      try {
        updateJobStep(job.id, 0, "running", "正在渲染 Mihomo 配置。");
        const nodes = ctx.repo.listNodes();
        const rendered = renderMihomoConfig(nodes, ctx.config, codexEgressRenderOpts(ctx.repo));
        await writeGenerated(ctx.config.mihomoConfigPath, rendered.yaml);
        await writeGenerated(`${ctx.config.generatedDir}/egress-map.json`, JSON.stringify(rendered.egressMap, null, 2));
        updateJobStep(job.id, 0, "success", `生成 ${rendered.egressMap.length} 个 listener。`);

        updateJobStep(job.id, 1, "running", "正在启动或重载 Mihomo。");
        const current = await readMihomoStatus(ctx.config);
        const status = current.running ? await reloadMihomo(ctx.config) : await startMihomo(ctx.config);
        updateJobStep(job.id, 1, "success", status.running ? "Mihomo 已运行。" : "未确认 Mihomo 运行状态。");
        finishJob(job.id, "success", "重建完成。");
        return { job: operationJobs.get(job.id), listeners: rendered.egressMap.length, status };
      } catch (error) {
        finishJob(job.id, "failed", error instanceof Error ? error.message : "未知错误");
        throw error;
      }
    })
  }),

  subscriptions: t.router({
    list: protectedProcedure.query(({ ctx }) => ctx.repo.listSubscriptions().map(summarizeSubscription)),
    previewImport: protectedProcedure
      .input(
        z.object({
          id: z.string().optional(),
          name: z.string().min(1).optional(),
          url: z.string().url().optional(),
          excludeKeywords: z.array(z.string()).default([])
        })
      )
      .mutation(async ({ ctx, input }) => {
        const source = resolvePreviewSource(ctx.repo, input);
        const content = await fetchSourceContent(ctx.repo, source);
        return buildSubscriptionImportPreview({
          source,
          content,
          existingNodes: ctx.repo.listNodes(),
          excludeKeywords: input.excludeKeywords.length > 0 ? input.excludeKeywords : source.excludeKeywords
        });
      }),
    applyImport: protectedProcedure
      .input(
        z.object({
          id: z.string().optional(),
          name: z.string().min(1),
          url: z.string().url(),
          excludeKeywords: z.array(z.string()).default([])
        })
      )
      .mutation(async ({ ctx, input }) => {
        const existing = input.id ? ctx.repo.listSubscriptions().find((item) => item.id === input.id) : undefined;
        const source =
          existing ??
          ctx.repo.addSubscription({
            id: input.id ?? randomUUID(),
            name: input.name,
            kind: "url",
            value: input.url
          });
        const filteredSource = ctx.repo.updateSubscriptionFilters(source.id, input.excludeKeywords);
        const content = await ctx.repo.fetchSubscriptionContent(filteredSource);
        ctx.repo.updateSubscriptionContent(filteredSource.id, content);
        const nodes = filterPreviewImportableNodes({
          source: filteredSource,
          content,
          existingNodes: ctx.repo.listNodes(),
          excludeKeywords: filteredSource.excludeKeywords
        }).map((node) => ({
          ...node,
          lifecycleStatus: "candidate" as const,
          schedulable: false
        }));
        const deleteHashes = filteredExistingNodeHashes({
          source: filteredSource,
          content,
          existingNodes: ctx.repo.listNodes(),
          excludeKeywords: filteredSource.excludeKeywords
        });
        const deletedByFilter = ctx.repo.deleteNodes(deleteHashes);
        ctx.repo.upsertNodes(nodes);
        return { imported: nodes.length, deletedByFilter, sourceId: filteredSource.id };
      }),
    add: protectedProcedure
      .input(z.object({ name: z.string().min(1), url: z.string().url() }))
      .mutation(({ ctx, input }) =>
        summarizeSubscription(ctx.repo.addSubscription({ id: randomUUID(), name: input.name, kind: "url", value: input.url }))
      ),
    fetch: protectedProcedure.mutation(async ({ ctx }) => {
      const results = [];
      for (const source of ctx.repo.listSubscriptions().filter((item) => item.enabled)) {
        const content = await ctx.repo.fetchSubscriptionContent(source);
        ctx.repo.updateSubscriptionContent(source.id, content);
        results.push({ id: source.id, name: source.name, bytes: content.length });
      }
      return results;
    }),
    updateFilters: protectedProcedure
      .input(z.object({ id: z.string().min(1), excludeKeywords: z.array(z.string()).default([]) }))
      .mutation(({ ctx, input }) => summarizeSubscription(ctx.repo.updateSubscriptionFilters(input.id, input.excludeKeywords))),
    delete: protectedProcedure.input(z.object({ id: z.string().min(1) })).mutation(({ ctx, input }) => {
      ctx.repo.deleteSubscription(input.id);
      return { ok: true };
    })
  }),

  nodes: t.router({
    list: protectedProcedure.query(({ ctx }) => ctx.repo.listNodes()),
    /**
     * P5-AS: 标记/取消「保留节点」—— 专用于账号注册/登录的高质量备用出口。
     * 批量切换；返回更新后的节点列表。
     */
    setCodexReserved: protectedProcedure
      .input(
        z.object({
          hashes: z.array(z.string().min(8)).min(1),
          reserved: z.boolean()
        })
      )
      .mutation(({ ctx, input }) => {
        let updated = 0;
        for (const hash of input.hashes) {
          if (ctx.repo.setNodeCodexReserved(hash, input.reserved)) updated += 1;
        }
        return { updated, nodes: ctx.repo.listNodes() };
      }),
    setLifecycle: protectedProcedure
      .input(
        z.object({
          hashes: z.array(z.string().min(8)).min(1),
          lifecycleStatus: z.enum(["candidate", "testing", "schedulable", "disabled", "draining", "cooling_down", "retired"])
        })
      )
      .mutation(({ ctx, input }) => {
        const nodes = ctx.repo.markNodesLifecycle(input.hashes, input.lifecycleStatus);
        return { updated: nodes.length, nodes };
      }),
    /**
     * 重置编排意图状态：清 intent_role / backoff_until / backoff_attempts /
     * health_score / last_health_check，让 reconcile 下次重新评估。
     *
     * 主要用途：被健康信号误判 quarantined / evicted 的节点恢复入池。
     * 可选 `liftFromRetired`：如果节点 lifecycle 是 retired，同时改回 schedulable
     * （否则只重置 intent，retired 节点不会被推送 / 接活）。
     */
    resetIntent: protectedProcedure
      .input(
        z.object({
          hashes: z.array(z.string().min(8)).min(1),
          liftFromRetired: z.boolean().default(true)
        })
      )
      .mutation(({ ctx, input }) => {
        // 先看一下哪些节点是 retired，决定是否要 lift
        const before = ctx.repo.listNodes().filter((node) => input.hashes.includes(node.hash));
        const retiredHashes = before
          .filter((node) => node.lifecycleStatus === "retired")
          .map((node) => node.hash);
        if (input.liftFromRetired && retiredHashes.length > 0) {
          ctx.repo.markNodesLifecycle(retiredHashes, "schedulable");
        }
        const reset = ctx.repo.resetNodeIntent(input.hashes);
        return {
          reset: reset.length,
          liftedFromRetired: input.liftFromRetired ? retiredHashes.length : 0,
          nodes: reset
        };
      }),
    /**
     * "启用调度" 按钮的语义：原子地把所选节点设为 schedulable，并同时推送到 Sub2API
     * （importProxyData + 回填 sub2apiProxyId）。这样节点立刻出现在编排器视野里，
     * 不再需要用户额外去高级运维页找"推送"按钮。
     *
     * Sub2API 未连接时只改 lifecycle，syncedCount=0，前端给出对应提示。
     */
    enableScheduling: protectedProcedure
      .input(z.object({ hashes: z.array(z.string().min(8)).min(1) }))
      .mutation(async ({ ctx, input }) => {
        // 1. 改 lifecycle
        const updatedNodes = ctx.repo.markNodesLifecycle(input.hashes, "schedulable");

        const connection = ctx.repo.getSub2ApiConnection();
        if (!connection) {
          return {
            updated: updatedNodes.length,
            syncedToSub2api: false,
            reason: "no-connection" as const,
            summary: null as null | Awaited<ReturnType<ReturnType<typeof createSub2ApiClient>["importProxyData"]>>,
            mappedNodes: 0
          };
        }

        // 2. 推送到 Sub2API（仅本批 hashes，且过滤 active + 已分端口）
        const payload = exportSub2Api(ctx.repo.listNodes(), {
          host: ctx.config.exportHost,
          namePrefix: connection.managedProxyPrefix,
          selectedHashes: input.hashes
        });
        const proxies = payload.proxies.filter((proxy) => proxy.status === "active");
        if (proxies.length === 0) {
          return {
            updated: updatedNodes.length,
            syncedToSub2api: false,
            reason: "no-active-with-port" as const,
            summary: null,
            mappedNodes: 0
          };
        }

        const client = createSub2ApiClient(connection);
        const summary = await client.importProxyData({ proxies });

        // 3. 回填 sub2apiProxyId
        const liveProxies = await client.listAllProxies();
        const mappings = mapLocalNodesToSub2ApiProxies({
          nodes: ctx.repo.listNodes(),
          proxies: liveProxies,
          exportHost: ctx.config.exportHost
        });
        ctx.repo.updateSub2ApiProxyMappings(mappings);

        return {
          updated: updatedNodes.length,
          syncedToSub2api: true,
          reason: null,
          summary,
          mappedNodes: mappings.length
        };
      }),
    previewDelete: protectedProcedure.input(z.object({ hashes: z.array(z.string().min(8)).min(1) })).query(async ({ ctx, input }) => {
      const nodes = selectNodes(ctx.repo.listNodes(), input.hashes);
      const snapshot = await loadSub2ApiSnapshot(ctx.repo);
      return buildNodeDeletionPlan({ nodes, proxies: snapshot.proxies, accounts: snapshot.accounts, exportHost: ctx.config.exportHost });
    }),
    applyDelete: protectedProcedure
      .input(
        z.object({
          hashes: z.array(z.string().min(8)).min(1),
          forceLocal: z.boolean().default(false)
        })
      )
      .mutation(async ({ ctx, input }) => {
        const nodes = selectNodes(ctx.repo.listNodes(), input.hashes);
        if (nodes.some((node) => node.protected)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "包含受保护节点，请先解除保护。" });
        }
        const connection = ctx.repo.getSub2ApiConnection();
        const client = connection && !input.forceLocal ? createSub2ApiClient(connection) : undefined;
        const job = createJob(
          "nodes.delete",
          "正在删除节点",
          client ? "先解绑 Sub2API 账号，再删除远端代理，最后删除本地节点。" : "未配置 Sub2API，仅删除本地节点。",
          client ? ["读取 Sub2API 关联", "解绑账号", "删除 Sub2API 代理", "删除本地节点"] : ["删除本地节点"]
        );
        try {
          let plan: NodeDeletionPlan = nodeDeletionPlanSchema.parse({
            nodes,
            blockingAccounts: [],
            canDeleteNow: true,
            requiresDrain: false,
            message: client ? "已重新读取 Sub2API 关联。" : "未配置 Sub2API，跳过远端清理。"
          });
          let unboundAccounts = 0;
          let deletedSub2ApiProxies = 0;
          const failedSub2ApiDeletes: Array<{ proxyId: number; name: string; message: string }> = [];

          if (client) {
            updateJobStep(job.id, 0, "running", "读取 Sub2API 代理与账号。");
            const [proxies, accounts] = await Promise.all([
              client.listAllProxies(),
              client.listAllAccounts(sub2ApiAccountFiltersSchema.parse({ status: "" }))
            ]);
            plan = buildNodeDeletionPlan({ nodes, proxies, accounts, exportHost: ctx.config.exportHost });
            const mappings = mapLocalNodesToSub2ApiProxies({ nodes, proxies, exportHost: ctx.config.exportHost });
            const proxyNames = new Map(proxies.map((proxy) => [proxy.id, proxy.name]));
            updateJobStep(job.id, 0, "success", `匹配到 ${mappings.length} 个 Sub2API 代理。`);

            updateJobStep(job.id, 1, "running", "查询每个代理 live 绑定账号并解绑。");
            const accountIdsToUnbind = new Set<number>();
            for (const mapping of mappings) {
              const bound = await client.listProxyAccounts(mapping.proxyId);
              for (const account of bound) {
                accountIdsToUnbind.add(account.id);
              }
            }
            if (accountIdsToUnbind.size > 0) {
              const result = await client.clearAccountProxy(Array.from(accountIdsToUnbind));
              unboundAccounts = result.success;
            }
            updateJobStep(job.id, 1, "success", `解绑 ${unboundAccounts} 个账号。`);

            updateJobStep(job.id, 2, "running", "删除 Sub2API 代理。");
            for (const mapping of mappings) {
              try {
                await client.deleteProxy(mapping.proxyId);
                deletedSub2ApiProxies += 1;
              } catch (error) {
                failedSub2ApiDeletes.push({
                  proxyId: mapping.proxyId,
                  name: proxyNames.get(mapping.proxyId) ?? `proxy-${mapping.proxyId}`,
                  message: error instanceof Error ? error.message : "未知错误"
                });
              }
            }
            updateJobStep(
              job.id,
              2,
              failedSub2ApiDeletes.length === 0 ? "success" : "failed",
              `删除 ${deletedSub2ApiProxies} 个代理，失败 ${failedSub2ApiDeletes.length} 个。`
            );
          }

          const localStepIndex = client ? 3 : 0;
          updateJobStep(job.id, localStepIndex, "running", "删除本地节点。");
          const deleted = ctx.repo.deleteNodes(input.hashes);
          updateJobStep(job.id, localStepIndex, "success", `删除 ${deleted} 个本地节点。`);

          const overallStatus = failedSub2ApiDeletes.length === 0 ? "success" : "failed";
          finishJob(
            job.id,
            overallStatus,
            client
              ? `本地删除 ${deleted}，远端解绑 ${unboundAccounts} 个账号，远端删除 ${deletedSub2ApiProxies}/${deletedSub2ApiProxies + failedSub2ApiDeletes.length} 个代理。`
              : `本地删除 ${deleted} 个节点。`
          );

          return {
            operationId: job.id,
            deleted,
            unboundAccounts,
            deletedSub2ApiProxies,
            failedSub2ApiDeletes,
            plan
          };
        } catch (error) {
          finishJob(job.id, "failed", error instanceof Error ? error.message : "未知错误");
          throw error;
        }
      }),
    import: protectedProcedure.mutation(async ({ ctx }) => {
      let imported = 0;
      for (const source of ctx.repo.listSubscriptions().filter((item) => item.enabled)) {
        const content = source.lastContent ?? (await ctx.repo.fetchSubscriptionContent(source));
        const nodes = filterPreviewImportableNodes({
          source,
          content,
          existingNodes: ctx.repo.listNodes(),
          excludeKeywords: source.excludeKeywords
        });
        ctx.repo.upsertNodes(nodes);
        imported += nodes.length;
      }
      return { imported };
    }),
    assignPorts: protectedProcedure
      .input(z.object({ range: z.string().optional(), skipPortCheck: z.boolean().default(false) }))
      .mutation(async ({ ctx, input }) => {
        const mihomoStatus = await readMihomoStatus(ctx.config);
        if (mihomoStatus.running) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Mihomo 运行中不能重新分配端口，请先停止 Mihomo。" });
        }
        const range = input.range ? parsePortRange(input.range) : { start: ctx.config.portRangeStart, end: ctx.config.portRangeEnd };
        const occupied = input.skipPortCheck ? new Set<number>() : await findOccupiedPorts(ctx.config.listenHost, enumeratePorts(range));
        const nodes = assignStablePorts({ nodes: ctx.repo.listNodes(), range, occupiedPorts: occupied, preserveExisting: false });
        ctx.repo.saveNodes(nodes);
        return { assigned: nodes.filter((node) => node.assignedPort).length, occupied: occupied.size };
      }),
    /**
     * "分配端口"按钮的后端：给所选节点分端口 + 渲染 + reload Mihomo，**不动 lifecycle**。
     *
     * 用途：用户拿到一批新导入的 candidate 节点，想先测试可用性再决定是否启用调度。
     * 接入后这些节点会被 Mihomo 渲染成 listener（占端口），但 Sub2API 推送 / 编排器
     * 仍然只看 schedulable，所以不会有账号被自动分到这些 candidate 节点上。
     */
    attachToMihomo: protectedProcedure
      .input(z.object({ hashes: z.array(z.string().min(8)).min(1) }))
      .mutation(async ({ ctx, input }) => {
        const job = createJob(
          "nodes.attach",
          "正在接入 Mihomo",
          `给 ${input.hashes.length} 个节点分配端口并刷新 Mihomo listener。`,
          ["分配端口", "渲染并 reload"]
        );
        try {
          updateJobStep(job.id, 0, "running", "正在分配端口。");
          const range = { start: ctx.config.portRangeStart, end: ctx.config.portRangeEnd };
          const status = await readMihomoStatus(ctx.config);
          // Mihomo running 时端口已被自己占着，不要扫描；只让目标节点保留 / 补分
          const occupied = status.running ? new Set<number>() : await findOccupiedPorts(ctx.config.listenHost, enumeratePorts(range));
          const assigned = assignStablePorts({
            nodes: ctx.repo.listNodes(),
            range,
            occupiedPorts: occupied,
            preserveExisting: true,
            targetHashes: input.hashes
          });
          ctx.repo.saveNodes(assigned);
          const succeededHashes = new Set(input.hashes);
          const newlyAssigned = assigned.filter((n) => succeededHashes.has(n.hash) && n.assignedPort).length;
          updateJobStep(job.id, 0, "success", `已分配 ${newlyAssigned} / ${input.hashes.length} 个端口。`);

          updateJobStep(job.id, 1, "running", "正在渲染并 reload Mihomo。");
          const rendered = renderMihomoConfig(assigned, ctx.config, codexEgressRenderOpts(ctx.repo));
          await writeGenerated(ctx.config.mihomoConfigPath, rendered.yaml);
          await writeGenerated(`${ctx.config.generatedDir}/egress-map.json`, JSON.stringify(rendered.egressMap, null, 2));
          const newStatus = status.running ? await reloadMihomo(ctx.config) : await startMihomo(ctx.config);
          updateJobStep(job.id, 1, "success", newStatus.running ? "Mihomo 已运行。" : "Mihomo 未运行。");
          finishJob(job.id, "success", `接入完成，共 ${rendered.egressMap.length} 个 listener。`);
          return {
            job: operationJobs.get(job.id),
            assigned: newlyAssigned,
            listeners: rendered.egressMap.length,
            status: newStatus
          };
        } catch (error) {
          finishJob(job.id, "failed", error instanceof Error ? error.message : "未知错误");
          throw error;
        }
      }),
    enableAllCandidates: protectedProcedure.mutation(({ ctx }) => {
      // 把所有 untested/candidate 节点显式提升为 schedulable；触发后 assignPorts/publish 才会
      // 把它们纳入端口池。明确动作避免之前 assignPorts 隐式 setAllUntestedActive 让用户无感
      // 启用所有节点造成的"为什么所有节点都占了端口"的困惑。
      ctx.repo.setAllUntestedActive();
      const nodes = ctx.repo.listNodes();
      return {
        promoted: nodes.filter((node) => node.lifecycleStatus === "schedulable" && !node.assignedPort).length,
        total: nodes.length
      };
    }),
    test: protectedProcedure
      .input(
        z.object({
          targets: z.array(z.string()).default(["openai", "claude"]),
          host: z.string().optional(),
          timeoutMs: z.number().int().positive().default(15_000),
          concurrency: z.number().int().positive().max(32).default(8),
          // 给定时只测这些 hash；否则跑全池（所有已分端口、非 retired）
          hashes: z.array(z.string().min(8)).optional()
        })
      )
      .mutation(async ({ ctx, input }) => {
        const targets = resolveProxyTestTargets(input.targets);
        const host = input.host ?? ctx.config.listenHost;
        const spec = ctx.repo.getOrchestrationSpec();
        const inPoolGate = spec.supply.inPoolGate;
        const hashFilter = input.hashes ? new Set(input.hashes) : undefined;
        // P6-16：用户"测试所选"时，若选中的节点还没分配端口（刚导入的 candidate），
        // 先给它们补端口 + 渲染 reload Mihomo，再测 —— 不必让用户手动先点"接入 Mihomo"。
        if (hashFilter) {
          const needPort = ctx.repo
            .listNodes()
            .filter((n) => hashFilter.has(n.hash) && !n.assignedPort && n.lifecycleStatus !== "retired");
          if (needPort.length > 0) {
            const range = { start: ctx.config.portRangeStart, end: ctx.config.portRangeEnd };
            const status = await readMihomoStatus(ctx.config);
            const occupied = status.running
              ? new Set<number>()
              : await findOccupiedPorts(ctx.config.listenHost, enumeratePorts(range));
            const assigned = assignStablePorts({
              nodes: ctx.repo.listNodes(),
              range,
              occupiedPorts: occupied,
              preserveExisting: true,
              targetHashes: needPort.map((n) => n.hash)
            });
            ctx.repo.saveNodes(assigned);
            const rendered = renderMihomoConfig(assigned, ctx.config, codexEgressRenderOpts(ctx.repo));
            await writeGenerated(ctx.config.mihomoConfigPath, rendered.yaml);
            await writeGenerated(`${ctx.config.generatedDir}/egress-map.json`, JSON.stringify(rendered.egressMap, null, 2));
            await (status.running ? reloadMihomo(ctx.config) : startMihomo(ctx.config));
          }
        }
        const candidates = ctx.repo
          .listNodes()
          .filter((node) => node.assignedPort && node.lifecycleStatus !== "retired")
          .filter((node) => !hashFilter || hashFilter.has(node.hash));
        // 区分两种调用模式：
        //   • hashFilter 给定（用户"测试所选"）：只更新质量信号，**不改 lifecycle**。
        //     由用户自己点"启用调度"决定纳入；否则测试本身就吃掉了决策权。
        //   • 未给 hashFilter（"测试全部"或定时任务）：保留原自动 lifecycle 调整行为。
        const manualMode = Boolean(hashFilter);
        const tested = await mapWithConcurrency(candidates, input.concurrency, async (node) => {
          // L1：服务直连代理 host:port 的 TCP 握手延迟（不经 mihomo、不经目标）。
          // 反映"我方→代理"的网络距离。从 node.raw 拿真实出口地址。
          const rawHost = typeof node.raw?.server === "string" ? node.raw.server : null;
          const rawPort = typeof node.raw?.port === "number" ? node.raw.port : null;
          const l1 =
            rawHost && rawPort
              ? await measureProxyTcpLatency({ host: rawHost, port: rawPort, timeoutMs: input.timeoutMs })
              : { latencyMs: 0, error: "no_raw_endpoint" };

          // L2：通过 mihomo listener 到每个业务目标（openai/claude）的端到端延迟
          const results = [];
          for (const target of targets) {
            results.push(await testProxyTarget({ host, port: Number(node.assignedPort), target, timeoutMs: input.timeoutMs }));
          }
          const passed = results.every((result) => result.ok);
          // 用 OpenAI/Claude 的最大延迟做 gate 判定（保持旧语义不变，只改 lastTestLatencyMs 字段含义）
          const targetMaxLatency = Math.max(...results.map((result) => result.latencyMs));
          const latencyExceeds = inPoolGate.maxLatencyMs ? targetMaxLatency > inPoolGate.maxLatencyMs : false;
          const inPool = passed && !latencyExceeds;
          const base = {
            ...node,
            status: passed ? ("active" as const) : ("failed" as const),
            qualityScore: passed ? (latencyExceeds ? 60 : 100) : 25,
            // 旧字段：保留 status 拼接给老 UI 兜底
            lastTestStatus: results.map((result) => `${result.targetId}:${result.httpStatus ?? result.message}`).join(","),
            // 新语义：lastTestLatencyMs = L1（服务→代理）
            lastTestLatencyMs: l1.latencyMs,
            // 新字段：每个目标的完整结果（含 L2 端到端 latency），JSON 字符串
            lastTestTargets: JSON.stringify(
              results.map((r) => ({
                targetId: r.targetId,
                ok: r.ok,
                latencyMs: r.latencyMs,
                ...(r.httpStatus !== undefined ? { httpStatus: r.httpStatus } : {}),
                message: r.message
              }))
            )
          };
          if (manualMode) {
            return base;
          }
          return {
            ...base,
            lifecycleStatus: inPool
              ? ("schedulable" as const)
              : passed
                ? ("disabled" as const)
                : ("cooling_down" as const),
            schedulable: inPool
          };
        });
        ctx.repo.saveNodes(tested);
        const gated = tested.filter(
          (node) => node.status === "active" && node.lifecycleStatus !== "schedulable"
        ).length;
        return {
          tested: tested.length,
          passed: tested.filter((node) => node.status === "active").length,
          failed: tested.filter((node) => node.status === "failed").length,
          gated
        };
      })
  }),

  mihomo: t.router({
    render: protectedProcedure.mutation(async ({ ctx }) => {
      const rendered = renderMihomoConfig(ctx.repo.listNodes(), ctx.config, codexEgressRenderOpts(ctx.repo));
      await writeGenerated(ctx.config.mihomoConfigPath, rendered.yaml);
      await writeGenerated(`${ctx.config.generatedDir}/egress-map.json`, JSON.stringify(rendered.egressMap, null, 2));
      return { listeners: rendered.egressMap.length };
    }),
    start: protectedProcedure.mutation(({ ctx }) => startMihomo(ctx.config)),
    stop: protectedProcedure.mutation(({ ctx }) => stopMihomo(ctx.config)),
    reload: protectedProcedure.mutation(({ ctx }) => reloadMihomo(ctx.config))
  }),

  exports: t.router({
    sub2api: protectedProcedure
      .input(z.object({ host: z.string().optional() }).optional())
      .query(({ ctx, input }) => exportSub2Api(ctx.repo.listNodes(), { host: input?.host ?? ctx.config.exportHost })),
    previewSub2api: protectedProcedure.input(sub2ApiExportRequestSchema).query(({ ctx, input }) =>
      previewSub2ApiExport(ctx.repo.listNodes(), {
        host: input.host ?? ctx.config.exportHost,
        selectedHashes: input.selectedHashes,
        failedNodeStatus: input.failedNodeStatus,
        namePrefix: ctx.repo.getSub2ApiConnection()?.managedProxyPrefix
      })
    ),
    writeSub2api: protectedProcedure
      .input(sub2ApiExportRequestSchema.extend({ output: z.string().optional() }))
      .mutation(async ({ ctx, input }) => {
        const payload = exportSub2Api(ctx.repo.listNodes(), {
          host: input.host ?? ctx.config.exportHost,
          selectedHashes: input.selectedHashes,
          failedNodeStatus: input.failedNodeStatus,
          namePrefix: ctx.repo.getSub2ApiConnection()?.managedProxyPrefix
        });
        const output = input.output ?? `${ctx.config.generatedDir}/sub2api-proxies.json`;
        await writeGenerated(output, `${JSON.stringify(payload, null, 2)}\n`);
        return { output, proxies: payload.proxies.length };
      })
  }),

  sub2api: t.router({
    config: t.router({
      get: protectedProcedure.query(({ ctx }) => ctx.repo.getSafeSub2ApiConnection()),
      save: protectedProcedure
        .input(sub2ApiConnectionConfigSchema.extend({ adminApiKey: z.string().optional() }))
        .mutation(({ ctx, input }) => {
          const current = ctx.repo.getSub2ApiConnection();
          if (!input.adminApiKey && !current?.adminApiKey) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "请填写 Sub2API 管理员 API Key。" });
          }
          ctx.repo.setSub2ApiConnection({ ...input, adminApiKey: input.adminApiKey || current?.adminApiKey || "" });
          return ctx.repo.getSafeSub2ApiConnection();
        }),
      // 先测后存（P5-AL）：可选传入 draft（baseUrl + 可选 adminApiKey）。
      //   - 传了 → 用 draft 临时构造 client 测试，不落库（让用户填完直接验证）
      //   - adminApiKey 留空但已有持久化 key → 复用持久化 key（配合"已保存留空不变"）
      //   - 没传 draft → 退回测试已持久化配置（旧行为）
      test: protectedProcedure
        .input(
          z
            .object({
              baseUrl: z.string().optional(),
              adminApiKey: z.string().optional()
            })
            .optional()
        )
        .mutation(async ({ ctx, input }) => {
          if (input?.baseUrl) {
            const current = ctx.repo.getSub2ApiConnection();
            const adminApiKey = input.adminApiKey || current?.adminApiKey || "";
            if (!adminApiKey) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "请填写 Sub2API 管理员 API Key 后再测试。"
              });
            }
            return createSub2ApiClient({
              baseUrl: input.baseUrl,
              adminApiKey,
              timezone: current?.timezone ?? "Asia/Shanghai",
              managedProxyPrefix: current?.managedProxyPrefix ?? "MH-"
            }).testConnection();
          }
          return createConfiguredSub2ApiClient(ctx.repo).testConnection();
        })
    }),
    proxies: t.router({
      list: protectedProcedure.query(async ({ ctx }) => createConfiguredSub2ApiClient(ctx.repo).listAllProxies()),
      saveProtectedRule: protectedProcedure.input(sub2ApiProtectedProxyRuleSchema).mutation(({ ctx, input }) => {
        ctx.repo.setSub2ApiProtectedRule(input);
        return ctx.repo.getSub2ApiProtectedRule();
      }),
      protectedRule: protectedProcedure.query(({ ctx }) => ctx.repo.getSub2ApiProtectedRule())
    }),
    accounts: t.router({
      list: protectedProcedure
        .input(sub2ApiAccountFiltersSchema.optional())
        .query(async ({ ctx, input }) => createConfiguredSub2ApiClient(ctx.repo).listAllAccounts(sub2ApiAccountFiltersSchema.parse(input ?? {})))
    }),
    assign: t.router({
      preview: protectedProcedure.input(sub2ApiAssignmentOptionsSchema).query(async ({ ctx, input }) => {
        const client = createConfiguredSub2ApiClient(ctx.repo);
        const [proxies, accounts] = await Promise.all([client.listAllProxies(), client.listAllAccounts(input.filters)]);
        return planSub2ApiAssignments({ proxies, accounts, options: input });
      }),
      applyChanges: protectedProcedure.input(sub2ApiAssignmentOptionsSchema).mutation(async ({ ctx, input }) => applySub2ApiAssignment(ctx.repo, input))
    }),
    sync: protectedProcedure.mutation(async ({ ctx }) => {
      const client = createConfiguredSub2ApiClient(ctx.repo);
      const [proxies, accounts] = await Promise.all([client.listAllProxies(), client.listAllAccounts(sub2ApiAccountFiltersSchema.parse({}))]);
      const mappings = mapLocalNodesToSub2ApiProxies({ nodes: ctx.repo.listNodes(), proxies, exportHost: ctx.config.exportHost });
      ctx.repo.updateSub2ApiProxyMappings(mappings);
      const protectedRule = ctx.repo.getSub2ApiProtectedRule();
      return {
        proxies: proxies.length,
        accounts: accounts.length,
        matchedLocalNodes: mappings.length,
        protectedProxies: proxies.filter((proxy) => matchesProtectedProxyLike(proxy, protectedRule)).length
      };
    }),
    maintenance: t.router({
      preview: protectedProcedure.query(async ({ ctx }) => {
        const client = createConfiguredSub2ApiClient(ctx.repo);
        const connection = ctx.repo.getSub2ApiConnection();
        const [proxies, accounts] = await Promise.all([
          client.listAllProxies(),
          client.listAllAccounts(sub2ApiAccountFiltersSchema.parse({ status: "" }))
        ]);
        return planSub2ApiManagedMaintenance({
          proxies,
          accounts,
          protectedRule: ctx.repo.getSub2ApiProtectedRule(),
          managedProxyPrefix: connection?.managedProxyPrefix ?? "MH-"
        });
      }),
      drainManaged: protectedProcedure.mutation(async ({ ctx }) => {
        const client = createConfiguredSub2ApiClient(ctx.repo);
        const connection = ctx.repo.getSub2ApiConnection();
        const [proxies, accounts] = await Promise.all([
          client.listAllProxies(),
          client.listAllAccounts(sub2ApiAccountFiltersSchema.parse({ status: "" }))
        ]);
        const preview = planSub2ApiManagedMaintenance({
          proxies,
          accounts,
          protectedRule: ctx.repo.getSub2ApiProtectedRule(),
          managedProxyPrefix: connection?.managedProxyPrefix ?? "MH-"
        });
        if (preview.risks.length > 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: preview.risks.join("；") });
        }
        const results = [];
        for (const batch of groupAssignmentChangesByProxy(preview.drainPlan.changes)) {
          results.push(await client.bulkUpdateProxy(batch.accountIds, batch.proxyId));
        }
        return {
          preview,
          reassigned: results.reduce((sum, item) => sum + item.success, 0),
          failedReassign: results.reduce((sum, item) => sum + item.failed, 0),
          deletedProxies: 0,
          failedDeleteProxies: []
        };
      }),
      cleanupEmpty: protectedProcedure.mutation(async ({ ctx }) => {
        const client = createConfiguredSub2ApiClient(ctx.repo);
        const connection = ctx.repo.getSub2ApiConnection();
        const [proxies, accounts] = await Promise.all([
          client.listAllProxies(),
          client.listAllAccounts(sub2ApiAccountFiltersSchema.parse({ status: "" }))
        ]);
        const preview = planSub2ApiManagedMaintenance({
          proxies,
          accounts,
          protectedRule: ctx.repo.getSub2ApiProtectedRule(),
          managedProxyPrefix: connection?.managedProxyPrefix ?? "MH-"
        });
        let deletedProxies = 0;
        const failedDeleteProxies = [];
        for (const proxy of preview.emptyManagedProxies) {
          try {
            await client.deleteProxy(proxy.id);
            deletedProxies += 1;
          } catch (error) {
            failedDeleteProxies.push({
              proxyId: proxy.id,
              name: proxy.name,
              message: error instanceof Error ? error.message : "未知错误"
            });
          }
        }
        return { preview, reassigned: 0, failedReassign: 0, deletedProxies, failedDeleteProxies };
      })
    }),
    automation: t.router({
      syncManagedProxies: protectedProcedure
        .input(z.object({ selectedHashes: z.array(z.string().min(8)).optional() }).default({}))
        .mutation(async ({ ctx, input }) => {
          const connection = ctx.repo.getSub2ApiConnection();
          if (!connection) {
            throw new TRPCError({ code: "PRECONDITION_FAILED", message: "请先配置 Sub2API 连接。" });
          }
          const job = createJob(
            "sub2api.automation.sync",
            "正在同步 Hive 节点到 Sub2API",
            "用 importProxyData 把本地 schedulable + active 节点推到 Sub2API，并回填 proxy_id。",
            ["整理本地节点", "推送 Sub2API", "回填 proxy_id"]
          );
          try {
            updateJobStep(job.id, 0, "running", "整理待同步节点。");
            const localNodes = ctx.repo.listNodes();
            const exportPayload = exportSub2Api(localNodes, {
              host: ctx.config.exportHost,
              namePrefix: connection.managedProxyPrefix,
              ...(input.selectedHashes ? { selectedHashes: input.selectedHashes } : {})
            });
            const proxies = exportPayload.proxies.filter((proxy) => proxy.status === "active");
            updateJobStep(job.id, 0, "success", `准备 ${proxies.length} 个 active 代理。`);
            if (proxies.length === 0) {
              finishJob(job.id, "success", "没有可同步的 active 节点。");
              return {
                operationId: job.id,
                summary: { proxy_created: 0, proxy_reused: 0, proxy_failed: 0, account_created: 0, account_failed: 0 },
                synced: 0,
                mappedNodes: 0
              };
            }

            updateJobStep(job.id, 1, "running", "调用 Sub2API importProxyData。");
            const client = createSub2ApiClient(connection);
            const summary = await client.importProxyData({ proxies });
            updateJobStep(
              job.id,
              1,
              "success",
              `新增 ${summary.proxy_created}，复用 ${summary.proxy_reused}，失败 ${summary.proxy_failed}。`
            );

            updateJobStep(job.id, 2, "running", "回填本地节点的 proxy_id 映射。");
            const liveProxies = await client.listAllProxies();
            const mappings = mapLocalNodesToSub2ApiProxies({
              nodes: localNodes,
              proxies: liveProxies,
              exportHost: ctx.config.exportHost
            });
            ctx.repo.updateSub2ApiProxyMappings(mappings);
            updateJobStep(job.id, 2, "success", `匹配 ${mappings.length} 个本地节点。`);

            finishJob(
              job.id,
              "success",
              `同步完成：新增 ${summary.proxy_created} / 复用 ${summary.proxy_reused} / 失败 ${summary.proxy_failed}。`
            );
            return {
              operationId: job.id,
              summary,
              synced: proxies.length,
              mappedNodes: mappings.length
            };
          } catch (error) {
            finishJob(job.id, "failed", error instanceof Error ? error.message : "未知错误");
            throw error;
          }
        }),
      qualityCheckManaged: protectedProcedure.mutation(async ({ ctx }) => {
        const connection = ctx.repo.getSub2ApiConnection();
        if (!connection) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "请先配置 Sub2API 连接。" });
        }
        const client = createSub2ApiClient(connection);
        const job = createJob(
          "sub2api.automation.qualityCheck",
          "正在对 Hive 托管代理执行质量检查",
          "对每个 Hive 托管代理调用 quality-check 并把分数回填到本地节点。",
          ["列出托管代理", "调用质量检查", "回填本地节点"]
        );
        try {
          updateJobStep(job.id, 0, "running", "拉取 Sub2API 代理列表。");
          const allProxies = await client.listAllProxies();
          const managedProxies = allProxies.filter((proxy) => isManagedProxy(proxy, connection.managedProxyPrefix));
          updateJobStep(job.id, 0, "success", `识别 ${managedProxies.length} 个托管代理。`);

          updateJobStep(job.id, 1, "running", `对 ${managedProxies.length} 个代理执行 quality-check。`);
          const results: Array<{
            proxyId: number;
            proxyName: string;
            score: number | null;
            grade: string | null;
            summary: string | null;
            error?: string;
          }> = [];
          for (const proxy of managedProxies) {
            try {
              const result = await client.qualityCheckProxy(proxy.id);
              results.push({
                proxyId: proxy.id,
                proxyName: proxy.name,
                score: result.score ?? null,
                grade: result.grade ?? null,
                summary: result.summary ?? null
              });
            } catch (error) {
              results.push({
                proxyId: proxy.id,
                proxyName: proxy.name,
                score: null,
                grade: null,
                summary: null,
                error: error instanceof Error ? error.message : "未知错误"
              });
            }
          }
          const passed = results.filter((item) => item.score !== null).length;
          updateJobStep(job.id, 1, "success", `${passed}/${results.length} 个检查返回有效分数。`);

          updateJobStep(job.id, 2, "running", "回填本地节点 qualityScore。");
          const proxyToScore = new Map<number, number>();
          for (const item of results) {
            if (item.score !== null) {
              proxyToScore.set(item.proxyId, item.score);
            }
          }
          const localNodes = ctx.repo.listNodes();
          const updates: ProxyNode[] = [];
          for (const node of localNodes) {
            if (!node.sub2apiProxyId) {
              continue;
            }
            const score = proxyToScore.get(node.sub2apiProxyId);
            if (score !== undefined && score !== node.qualityScore) {
              updates.push({ ...node, qualityScore: score });
            }
          }
          if (updates.length > 0) {
            ctx.repo.saveNodes(updates);
          }
          updateJobStep(job.id, 2, "success", `更新 ${updates.length} 个本地节点的 qualityScore。`);

          finishJob(
            job.id,
            "success",
            `质量检查完成：${passed}/${results.length} 通过，回填 ${updates.length} 个本地节点。`
          );
          return {
            operationId: job.id,
            total: results.length,
            passed,
            updatedLocalNodes: updates.length,
            results
          };
        } catch (error) {
          finishJob(job.id, "failed", error instanceof Error ? error.message : "未知错误");
          throw error;
        }
      }),
      upstreamErrorSummary: protectedProcedure
        .input(
          z
            .object({
              timeRange: z.string().min(1).default("1h"),
              view: z.string().min(1).default("errors"),
              phase: z.string().min(1).default("upstream")
            })
            .default({})
        )
        .query(async ({ ctx, input }) => {
          const connection = ctx.repo.getSub2ApiConnection();
          if (!connection) {
            throw new TRPCError({ code: "PRECONDITION_FAILED", message: "请先配置 Sub2API 连接。" });
          }
          const client = createSub2ApiClient(connection);
          const [errors, accounts, proxies] = await Promise.all([
            client.listAllUpstreamErrors({ timeRange: input.timeRange, view: input.view, phase: input.phase }),
            client.listAllAccounts(sub2ApiAccountFiltersSchema.parse({ status: "" })),
            client.listAllProxies()
          ]);
          const accountToProxy = new Map<number, number>();
          for (const account of accounts) {
            if (account.proxy_id) {
              accountToProxy.set(account.id, account.proxy_id);
            }
          }
          const proxyNames = new Map(proxies.map((proxy) => [proxy.id, proxy.name]));
          const proxyToNodeHash = new Map<number, string>();
          for (const node of ctx.repo.listNodes()) {
            if (node.sub2apiProxyId) {
              proxyToNodeHash.set(node.sub2apiProxyId, node.hash);
            }
          }

          const byProxy = new Map<
            number,
            {
              proxyId: number;
              proxyName: string;
              nodeHash: string | null;
              errors: number;
              byStatus: Record<string, number>;
              bySeverity: Record<string, number>;
            }
          >();
          let attributed = 0;
          let unattributed = 0;
          for (const error of errors) {
            const accountId = error.account_id ?? null;
            const proxyId = accountId ? accountToProxy.get(accountId) : undefined;
            if (!proxyId) {
              unattributed += 1;
              continue;
            }
            attributed += 1;
            let bucket = byProxy.get(proxyId);
            if (!bucket) {
              bucket = {
                proxyId,
                proxyName: proxyNames.get(proxyId) ?? `proxy-${proxyId}`,
                nodeHash: proxyToNodeHash.get(proxyId) ?? null,
                errors: 0,
                byStatus: {},
                bySeverity: {}
              };
              byProxy.set(proxyId, bucket);
            }
            bucket.errors += 1;
            if (error.status_code !== null && error.status_code !== undefined) {
              const key = String(error.status_code);
              bucket.byStatus[key] = (bucket.byStatus[key] ?? 0) + 1;
            }
            if (error.severity) {
              bucket.bySeverity[error.severity] = (bucket.bySeverity[error.severity] ?? 0) + 1;
            }
          }

          return {
            timeRange: input.timeRange,
            total: errors.length,
            attributed,
            unattributed,
            byProxy: Array.from(byProxy.values()).sort((a, b) => b.errors - a.errors)
          };
        })
    }),
    spec: t.router({
      get: protectedProcedure.query(({ ctx }) => ctx.repo.getOrchestrationSpec()),
      save: protectedProcedure.input(orchestrationSpecSchema).mutation(async ({ ctx, input }) => {
        // 校验 intake 配置：不能命中保护规则、不能是托管代理、要存在
        if (input.intake.proxyId !== null) {
          const connection = ctx.repo.getSub2ApiConnection();
          if (!connection) {
            throw new TRPCError({ code: "PRECONDITION_FAILED", message: "请先配置 Sub2API 连接。" });
          }
          const client = createSub2ApiClient(connection);
          const proxies = await client.listAllProxies();
          const err = validateIntakeAgainstSpec(input, proxies, connection.managedProxyPrefix);
          if (err) throw new TRPCError({ code: "BAD_REQUEST", message: err });
        }
        const saved = ctx.repo.saveOrchestrationSpec(input);
        // 立即触发一次 reconcile（让 spec 改动立即生效）
        if (ctx.orchestrator) {
          void ctx.orchestrator.triggerNow().catch(() => undefined);
        }
        return saved;
      })
    }),
    orchestrator: t.router({
      statusSnapshot: protectedProcedure.query(({ ctx }) => {
        const spec = ctx.repo.getOrchestrationSpec();
        // 性能改造：
        //   • recentTicks 走轻量 summary（不读 JSON 大列、不走 zod parse），
        //     500 条原本 ~500ms → 现在 ~5ms。
        //   • lastTick 单独读完整一条（KpiCards + NodeMatrix 需要）。
        //   • driftCount24h 走 SQL JSON1 聚合，避免在 JS 层 reduce 500 条 ticks。
        const summaries = ctx.repo.listRecentReconcileTickSummaries(200);
        const lastTickId = summaries[0]?.id;
        const lastTick = lastTickId ? ctx.repo.getReconcileTick(lastTickId) : undefined;
        const since24hIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const driftCount24h = ctx.repo.countDriftAppliedChanges(since24hIso);
        const kpis = {
          healthyProxies: lastTick?.observedSummary.proxiesServing ?? 0,
          totalProxies: lastTick?.observedSummary.proxiesTotal ?? 0,
          utilizationPercent: lastTick?.observedSummary.utilizationPercent ?? 0,
          driftCount24h,
          quarantinedCount: lastTick?.observedSummary.proxiesQuarantined ?? 0
        };
        return {
          spec,
          ...(lastTick ? { lastTick } : {}),
          recentTicks: summaries,
          nodeIntents: lastTick?.nodeIntents ?? [],
          ...(lastTick?.observedSummary ? { observedSummary: lastTick.observedSummary } : {}),
          kpis
        };
      }),
      tickDetail: protectedProcedure
        .input(z.object({ id: z.string().min(1) }))
        .query(({ ctx, input }) => {
          const tick = ctx.repo.getReconcileTick(input.id);
          if (!tick) {
            throw new TRPCError({ code: "NOT_FOUND", message: `Reconcile tick ${input.id} not found` });
          }
          return tick;
        }),
      applyOnce: protectedProcedure.mutation(async ({ ctx }) => {
        if (!ctx.orchestrator) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Orchestrator 未启用。" });
        }
        return ctx.orchestrator.triggerNow();
      }),
      pause: protectedProcedure.mutation(({ ctx }) => {
        const spec = ctx.repo.getOrchestrationSpec();
        if (spec.enabled === false) return spec;
        return ctx.repo.saveOrchestrationSpec({ ...spec, enabled: false });
      }),
      resume: protectedProcedure.mutation(({ ctx }) => {
        const spec = ctx.repo.getOrchestrationSpec();
        if (spec.enabled === true) return spec;
        const saved = ctx.repo.saveOrchestrationSpec({ ...spec, enabled: true });
        if (ctx.orchestrator) {
          void ctx.orchestrator.triggerNow().catch(() => undefined);
        }
        return saved;
      }),
      tickHistory: protectedProcedure
        .input(z.object({ limit: z.number().int().min(1).max(100).default(20) }).default({}))
        .query(({ ctx, input }) => ctx.repo.listRecentReconcileTicks(input.limit)),
      // 切换日工具：预览或一次性执行哈希策略切换。
      previewStrategySwitch: protectedProcedure
        .input(z.object({ target: z.enum(["stable-hash", "rendezvous-hash"]) }))
        .mutation(async ({ ctx, input }) => {
          const connection = ctx.repo.getSub2ApiConnection();
          if (!connection) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "请先配置 Sub2API 连接。" });
          const client = createSub2ApiClient(connection);
          const [proxies, accounts] = await Promise.all([
            client.listAllProxies(),
            client.listAllAccounts(sub2ApiAccountFiltersSchema.parse({ status: "" }))
          ]);
          const spec = ctx.repo.getOrchestrationSpec();
          const servingProxyIds = new Set(
            ctx.repo
              .listNodes()
              .filter((n) => n.sub2apiProxyId && (n.intentRole === "serving" || n.lifecycleStatus === "schedulable"))
              .map((n) => n.sub2apiProxyId!)
          );
          return planStrategySwitch({
            spec,
            targetStrategy: input.target,
            proxies,
            accounts,
            managedProxyPrefix: connection.managedProxyPrefix,
            servingProxyIds
          });
        }),
      applyStrategySwitch: protectedProcedure
        .input(z.object({ target: z.enum(["stable-hash", "rendezvous-hash"]) }))
        .mutation(async ({ ctx, input }) => {
          const connection = ctx.repo.getSub2ApiConnection();
          if (!connection) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "请先配置 Sub2API 连接。" });
          const client = createSub2ApiClient(connection);
          const [proxies, accounts] = await Promise.all([
            client.listAllProxies(),
            client.listAllAccounts(sub2ApiAccountFiltersSchema.parse({ status: "" }))
          ]);
          const spec = ctx.repo.getOrchestrationSpec();
          const servingProxyIds = new Set(
            ctx.repo
              .listNodes()
              .filter((n) => n.sub2apiProxyId && (n.intentRole === "serving" || n.lifecycleStatus === "schedulable"))
              .map((n) => n.sub2apiProxyId!)
          );
          const plan = planStrategySwitch({
            spec,
            targetStrategy: input.target,
            proxies,
            accounts,
            managedProxyPrefix: connection.managedProxyPrefix,
            servingProxyIds
          });

          const job = createJob(
            "sub2api.automation.strategySwitch",
            `切换哈希策略 ${plan.fromStrategy} → ${plan.toStrategy}`,
            `一次性大规模迁移：${plan.affectedAccounts} 个账号`,
            ["执行批量绑定", "保存策略到 Spec"]
          );
          try {
            // 按 toProxyId 分组 bulkUpdate
            updateJobStep(job.id, 0, "running", `执行 ${plan.affectedAccounts} 个变更`);
            const groups = new Map<number, number[]>();
            for (const change of plan.changes) {
              const list = groups.get(change.toProxyId) ?? [];
              list.push(change.accountId);
              groups.set(change.toProxyId, list);
            }
            let success = 0;
            let failed = 0;
            for (const [toProxyId, accountIds] of groups) {
              const result = await client.bulkUpdateProxy(accountIds, toProxyId);
              success += result.success;
              failed += result.failed;
            }
            updateJobStep(job.id, 0, "success", `成功 ${success}，失败 ${failed}`);

            updateJobStep(job.id, 1, "running", "保存新策略到 Spec");
            ctx.repo.saveOrchestrationSpec({
              ...spec,
              stickiness: { ...spec.stickiness, strategy: input.target }
            });
            updateJobStep(job.id, 1, "success", "Spec 已更新");

            finishJob(job.id, "success", `${input.target} 上线：迁移 ${success} 个账号`);
            return { plan, success, failed, operationId: job.id };
          } catch (err) {
            const message = err instanceof Error ? err.message : "未知错误";
            finishJob(job.id, "failed", message);
            throw err;
          }
        })
    }),
    reconcile: t.router({
      preview: protectedProcedure.input(sub2ApiAssignmentOptionsSchema).query(async ({ ctx, input }) => {
        const client = createConfiguredSub2ApiClient(ctx.repo);
        const [proxies, accounts] = await Promise.all([client.listAllProxies(), client.listAllAccounts(input.filters)]);
        const preview = planSub2ApiAssignments({ proxies, accounts, options: input });
        return { ...preview, mode: "steady_balance" as const, affectedNodeHashes: [], risks: preview.errors };
      }),
      applyChanges: protectedProcedure.input(sub2ApiAssignmentOptionsSchema).mutation(async ({ ctx, input }) => {
        const operationId = createJob("sub2api.reconcile", "正在协调 Sub2API 账号绑定", "重新读取账号与代理后执行确定性绑定。").id;
        try {
          const result = await applySub2ApiAssignment(ctx.repo, input);
          finishJob(operationId, "success", `成功 ${result.success} 个，失败 ${result.failed} 个。`);
          return { ...result, operationId };
        } catch (error) {
          finishJob(operationId, "failed", error instanceof Error ? error.message : "未知错误");
          throw error;
        }
      })
    }),
    jobs: t.router({
      list: protectedProcedure.query(() => Array.from(operationJobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
      get: protectedProcedure.input(z.object({ id: z.string().min(1) })).query(({ input }) => operationJobs.get(input.id))
    })
  }),

  // ─── Account Fleet (notes/account-fleet-design.md) ────────────
  accountFleet: t.router({
    spec: t.router({
      get: protectedProcedure.query(({ ctx }) => ctx.repo.getAccountFleetSpec()),
      save: protectedProcedure
        .input(accountFleetSpecSchema)
        .mutation(({ ctx, input }) => {
          const saved = ctx.repo.saveAccountFleetSpec(input);
          // 立即触发一次 tick，让用户看到新策略下的 plan
          if (ctx.accountFleetScheduler) {
            void ctx.accountFleetScheduler.triggerNow().catch(() => undefined);
          }
          return saved;
        }),
      defaults: protectedProcedure.query(() => defaultAccountFleetSpec)
    }),
    // P5-AF: codex-tool 子区块独立保存 + 连通测试。
    // 独立保存的意义：用户在加密 password / api key 时需要边测边调，不希望
    // 每改一个字段都把整张 spec 全表单 dirty 起来逼着用户其它面板上下文丢失。
    codexTool: t.router({
      // 保存只覆盖 spec.codexTool 子树；其它字段保持原值（避免与其它面板编辑撞车）
      save: protectedProcedure
        .input(accountFleetSpecSchema.shape.codexTool)
        .mutation(async ({ ctx, input }) => {
          const current = ctx.repo.getAccountFleetSpec();
          const saved = ctx.repo.saveAccountFleetSpec({ ...current, codexTool: input });
          // 动态出口(codexEgress)开关/参数变化时,mihomo 的 codex-egress 单口+组需要重渲染
          // 才生效——否则改了 spec 但运行配置还是旧的(组是空的 → worker 切组 404)。
          // best-effort 重渲染 + reload,失败不阻塞保存。
          try {
            const rendered = renderMihomoConfig(ctx.repo.listNodes(), ctx.config, codexEgressRenderOpts(ctx.repo));
            await writeGenerated(ctx.config.mihomoConfigPath, rendered.yaml);
            await writeGenerated(`${ctx.config.generatedDir}/egress-map.json`, JSON.stringify(rendered.egressMap, null, 2));
            const status = await readMihomoStatus(ctx.config);
            if (status.running) await reloadMihomo(ctx.config);
          } catch (err) {
            console.warn("codexTool.save 重渲染 mihomo 失败(不阻塞保存):", err instanceof Error ? err.message : err);
          }
          if (ctx.accountFleetScheduler) {
            void ctx.accountFleetScheduler.triggerNow().catch(() => undefined);
          }
          return saved.codexTool;
        }),
      /**
       * 连通测试 —— 用 codex-tool 的 sms countries 命令打全链路：
       *   spawn binary → 解析 envelope → 链路里需要 SkyMail 配置 + phoneSms apiKey 都齐
       * 任一环节失败都能精确报错，比一个 --version 更有用。
       *
       * 先测后存（P5-AL）：可选传入 codexTool draft，用 draft 临时构造 adapter 测试，
       * 不写库。draft 值与 save 后持久化值、与 buildCodexToolAdapter 取用值完全同源，
       * 所以"测 draft"与"保存后测"等价。不传则退回测已持久化 spec（旧行为）。
       */
      test: protectedProcedure
        .input(accountFleetSpecSchema.shape.codexTool.optional())
        .mutation(async ({ ctx, input }) => {
          const persisted = ctx.repo.getAccountFleetSpec();
          const spec = input ? { ...persisted, codexTool: input } : persisted;
          try {
            const adapter = await buildCodexToolAdapter(ctx.repo, safeLoadCrypto(), spec, null);
            const result = await adapter.smsCountries({ limit: 1, timeoutMs: 15_000 });
            return {
              ok: true as const,
              provider: result.provider,
              service: result.service,
              countriesSampled: result.countries.length,
              totalCountries: result.total
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { ok: false as const, error: message };
          }
        })
    }),
    /**
     * P5-AT: 某 job 的实时日志。运行中 → 进程内缓冲（worker 里程碑 + codex stderr）；
     * 已结束 → DB 持久化的 log_tail。UI 展开行时轮询。
     */
    jobLog: protectedProcedure
      .input(z.object({ jobId: z.string().min(1) }))
      .query(({ ctx, input }) => {
        const live = getJobLog(input.jobId);
        if (live.length > 0) {
          return { live: true as const, lines: live };
        }
        const job = ctx.repo.getAccountJob(input.jobId);
        const tail = job?.logTail ?? "";
        return {
          live: false as const,
          lines: tail
            ? tail.split("\n").map((text) => ({ ts: "", text }))
            : []
        };
      }),
    status: protectedProcedure.query(async ({ ctx }): Promise<AccountFleetStatusSnapshot> => {
      const spec = ctx.repo.getAccountFleetSpec();
      const accounts = ctx.repo.listAccounts();
      const recentTicks = ctx.repo.listRecentAccountFleetTickSummaries(50);
      const recentJobs = ctx.repo.listAccountJobs(50);
      const runningJobs = ctx.repo.listRunningAccountJobs();
      const queuedJobCount = ctx.repo.countQueuedAccountJobs();
      const recentFinishedJobs = ctx.repo.listRecentFinishedAccountJobs(30);
      const recentFailureReasons = aggregateFailureReasons(ctx.repo.listRecentFailureMessages(150));
      const lastTickSummary = recentTicks[0];
      const lastTick = lastTickSummary ? ctx.repo.getAccountFleetTick(lastTickSummary.id) : undefined;

      // P5-AG: 拼"当前出口节点" —— Sub2API account.proxy_id → 本地 nodes.sub2apiProxyId
      //   失败（Sub2API 未配置 / 离线 / 接口报错）静默 fallback，账号视图仍能返回，
      //   currentNodeName 留 null 即可，UI 自有 fallback 链。
      let proxyIdByExternalId = new Map<number, number>();
      // P5-AU: externalId → Sub2API "限流中" 冷却信号（live）
      const coolingByExternalId = new Map<
        number,
        { until: string | null; reason: string | null; resetAt: string | null }
      >();
      try {
        // status:"" 拉全量 —— schema 默认 status:"active"，但实测 Sub2API 对
        // status=active 返回 0（其 status 过滤值语义不同），会导致漏掉所有账号。
        // 跟 orchestrator sense 保持一致用空 status。
        const sub2apiAccounts = await createConfiguredSub2ApiClient(ctx.repo).listAllAccounts(
          sub2ApiAccountFiltersSchema.parse({ status: "" })
        );
        proxyIdByExternalId = new Map(
          sub2apiAccounts
            .filter((a): a is typeof a & { proxy_id: number } => typeof a.proxy_id === "number")
            .map((a) => [a.id, a.proxy_id])
        );
        for (const a of sub2apiAccounts) {
          if (a.temp_unschedulable_until || a.rate_limit_reset_at) {
            coolingByExternalId.set(a.id, {
              until: a.temp_unschedulable_until ?? null,
              reason: a.temp_unschedulable_reason ?? null,
              resetAt: a.rate_limit_reset_at ?? null
            });
          }
        }
      } catch {
        // Sub2API 未配置或失败 —— currentNodeName 全显示 —
      }
      const nodeByProxyId = new Map<number, { hash: string; name: string }>();
      for (const n of ctx.repo.listNodes()) {
        if (n.sub2apiProxyId) nodeByProxyId.set(n.sub2apiProxyId, { hash: n.hash, name: n.name });
      }

      const accountViews: AccountRecordView[] = accounts.map((a) => {
        const base = toAccountView(a);
        if (a.externalId === null) return base;
        const cooling = coolingByExternalId.get(a.externalId);
        // P5-AU: 合并 live 冷却信号；rateLimitResetAt 用 live 覆盖持久化值（更新鲜）
        const withCooling: AccountRecordView = cooling
          ? {
              ...base,
              tempUnschedulableUntil: cooling.until,
              tempUnschedulableReason: cooling.reason,
              ...(cooling.resetAt ? { rateLimitResetAt: cooling.resetAt } : {})
            }
          : base;
        const proxyId = proxyIdByExternalId.get(a.externalId);
        if (!proxyId) return withCooling;
        const node = nodeByProxyId.get(proxyId);
        return {
          ...withCooling,
          currentProxyId: proxyId,
          currentNodeHash: node?.hash ?? null,
          currentNodeName: node?.name ?? null
        };
      });
      const healthyCount = accountViews.filter((a) => a.health === "healthy").length;
      const brokenCount = accountViews.filter((a) => a.health === "broken").length;
      const recoveringCount = accountViews.filter((a) => a.intent === "recovering").length;
      const pendingCount = accountViews.filter((a) => a.intent === "pending").length;
      // P6-02 池子分段：把 broken 拆成"可恢复"(有凭据、未退役 → 还能救) vs "真死"
      //   (已退役 / 无凭据救不了)；quota/rate 单列 → 让用户区分"冷却中(等会儿好)"。
      const quotaExhaustedCount = accountViews.filter((a) => a.health === "quota_exhausted").length;
      const rateLimitedCount = accountViews.filter((a) => a.health === "rate_limited").length;
      const recoverableCount = accountViews.filter(
        (a) => a.health === "broken" && a.intent !== "retired" && (a.hasPhonePassword || a.hasRefreshToken)
      ).length;
      const deadCount = brokenCount - recoverableCount;
      const dayKey = budgetWindowKeyUtc(new Date(), "day");
      const monthKey = budgetWindowKeyUtc(new Date(), "month");
      const dayBudget = ctx.repo.getAccountBudget(dayKey);
      const monthBudget = ctx.repo.getAccountBudget(monthKey);
      return accountFleetStatusSnapshotSchema.parse({
        spec,
        ...(lastTick ? { lastTick } : {}),
        recentTicks,
        accounts: accountViews,
        recentJobs,
        runningJobs,
        queuedJobCount,
        recentFinishedJobs,
        recentFailureReasons,
        kpis: {
          totalAccounts: accountViews.length,
          healthyCount,
          target: spec.target.healthyAccountsTarget,
          brokenCount,
          recoveringCount,
          pendingCount,
          quotaExhaustedCount,
          rateLimitedCount,
          recoverableCount,
          deadCount,
          todayRegistrationsUsed: dayBudget?.registrationsUsed ?? 0,
          todayRegistrationsBudget: spec.registration.dailyBudget,
          monthlyRegistrationsUsed: monthBudget?.registrationsUsed ?? 0,
          monthlyRegistrationsBudget: spec.registration.monthlyBudget,
          todaySmsCostCents: dayBudget?.smsCostCents ?? 0,
          monthlySmsCostCents: monthBudget?.smsCostCents ?? 0
        },
        smsRegionHint: ctx.repo.getSmsRegionHint()
      });
    }),
    tick: t.router({
      triggerNow: protectedProcedure.mutation(async ({ ctx }) => {
        if (!ctx.accountFleetScheduler) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Account fleet scheduler is disabled (HIVE_DISABLE_ACCOUNT_FLEET=true)"
          });
        }
        return ctx.accountFleetScheduler.triggerNow();
      }),
      get: protectedProcedure
        .input(z.object({ id: z.string().min(1) }))
        .query(({ ctx, input }) => ctx.repo.getAccountFleetTick(input.id)),
      recent: protectedProcedure
        .input(z.object({ limit: z.number().int().min(1).max(200).default(20) }).optional())
        .query(({ ctx, input }) => ctx.repo.listRecentAccountFleetTickSummaries(input?.limit ?? 20))
    }),

    // 手动账号操作 —— 收编工作台 / 单条账号 dropdown 触发
    actions: t.router({
      /**
       * P5-AW 重新编排队列：取消所有 queued 的恢复类 job(不动 running)，再触发一次新
       * tick 重新规划。用于调整均衡度/策略后、或旧队列被陈旧重复任务卡住时一键重置。
       */
      regenerateQueue: protectedProcedure.mutation(async ({ ctx }) => {
        const cancelled = ctx.repo.cancelAllQueuedRecoveryJobs();
        let tick: Awaited<ReturnType<NonNullable<typeof ctx.accountFleetScheduler>["triggerNow"]>> | null = null;
        if (ctx.accountFleetScheduler) {
          tick = await ctx.accountFleetScheduler.triggerNow();
        }
        if (ctx.accountJobsWorker) void ctx.accountJobsWorker.pump().catch(() => undefined);
        return { cancelled, replanned: tick !== null };
      }),
      /** 单账号运维开关。false=暂停该账号一切自动化(恢复/重绑等任务分配)。 */
      setOpsEnabled: protectedProcedure
        .input(z.object({ accountId: z.string().min(1), enabled: z.boolean() }))
        .mutation(({ ctx, input }) => {
          const acc = ctx.repo.setAccountOpsEnabled(input.accountId, input.enabled);
          if (!acc) throw new TRPCError({ code: "NOT_FOUND", message: "account not found" });
          return { id: acc.id, opsEnabled: acc.opsEnabled };
        }),
      /** 批量运维开关。onlyNonActive=true 只动非 active 账号(典型:停掉所有死号/恢复中、留正常 active);
       *  典型用法:一键停掉所有现有账号,只让新注册账号跑实验,避免死号干扰。 */
      setAllOpsEnabled: protectedProcedure
        .input(z.object({ enabled: z.boolean(), onlyNonActive: z.boolean().default(false) }))
        .mutation(({ ctx, input }) => {
          return ctx.repo.setAllOpsEnabled(input.enabled, { onlyNonActive: input.onlyNonActive });
        }),
      /** 手动入队 codex_login 修复 job。要求账号已有 phone+password。 */
      enqueueRecoverLogin: protectedProcedure
        .input(z.object({ accountId: z.string().min(1) }))
        .mutation(({ ctx, input }) => {
          const acc = ctx.repo.getAccountById(input.accountId);
          if (!acc) throw new TRPCError({ code: "NOT_FOUND", message: "account not found" });
          if (!acc.encPhone || !acc.encPassword) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "account lacks phone/password; cannot run codex_login"
            });
          }
          const now = new Date().toISOString();
          ctx.repo.enqueueAccountJob({
            id: randomUUID(),
            kind: "codex_login",
            accountId: acc.id,
            status: "queued",
            attempt: 0,
            maxAttempts: 1,
            priority: 50,
            scheduledAt: now,
            startedAt: null,
            finishedAt: null,
            durationMs: null,
            payloadJson: JSON.stringify({ reason: "manual" }),
            resultJson: null,
            errorMessage: null,
            triggeredBy: "manual",
            triggeredTickId: null,
            createdAt: now,
            updatedAt: now
          });
          // 立刻 pump 让 worker 尽快消费
          if (ctx.accountJobsWorker) {
            void ctx.accountJobsWorker.pump().catch(() => undefined);
          }
          return { enqueued: true };
        }),
      /**
       * 手动入队 codex_register 批量注册新账号（不绑定旧账号）。
       *   count    —— 一次入队几个（1-50）。
       *   jumpQueue—— true(默认) 时给极高优先级(priority=5)插到所有队列任务前面
       *              （恢复 codex_login=100、自动注册=默认更低优先；5 会被最先认领）。
       *              codex-tool 串行闸门下它们仍逐个执行，但排在所有 queued 之前。
       * 手动入队不受 spec.registration.enabled 门控（那个只管自动规划）——用户主动
       * 下发就执行，方便"现在就注册一批"。
       */
      enqueueRegisterNew: protectedProcedure
        .input(
          z
            .object({
              count: z.number().int().min(1).max(50).default(1),
              jumpQueue: z.boolean().default(true)
            })
            .default({})
        )
        .mutation(({ ctx, input }) => {
          const now = new Date().toISOString();
          const priority = input.jumpQueue ? 5 : 80;
          for (let i = 0; i < input.count; i++) {
            ctx.repo.enqueueAccountJob({
              id: randomUUID(),
              kind: "codex_register",
              accountId: null,
              status: "queued",
              attempt: 0,
              maxAttempts: 1,
              priority,
              scheduledAt: now,
              startedAt: null,
              finishedAt: null,
              durationMs: null,
              payloadJson: JSON.stringify({ reason: "manual", batch: input.count }),
              resultJson: null,
              errorMessage: null,
              triggeredBy: "manual",
              triggeredTickId: null,
              createdAt: now,
              updatedAt: now
            });
          }
          if (ctx.accountJobsWorker) void ctx.accountJobsWorker.pump().catch(() => undefined);
          return { enqueued: input.count, priority };
        }),
      /** 试探导入：用户提供 refresh_token，看是否还能复活账号。 */
      enqueueImportRefreshToken: protectedProcedure
        .input(z.object({ refreshToken: z.string().min(1), existingAccountId: z.string().optional() }))
        .mutation(({ ctx, input }) => {
          const now = new Date().toISOString();
          ctx.repo.enqueueAccountJob({
            id: randomUUID(),
            kind: "import_to_sub2api",
            accountId: input.existingAccountId ?? null,
            status: "queued",
            attempt: 0,
            maxAttempts: 1,
            priority: 60,
            scheduledAt: now,
            startedAt: null,
            finishedAt: null,
            durationMs: null,
            payloadJson: JSON.stringify({
              refreshToken: input.refreshToken,
              existingAccountId: input.existingAccountId
            }),
            resultJson: null,
            errorMessage: null,
            triggeredBy: "adopter",
            triggeredTickId: null,
            createdAt: now,
            updatedAt: now
          });
          if (ctx.accountJobsWorker) void ctx.accountJobsWorker.pump().catch(() => undefined);
          return { enqueued: true };
        }),
      /** 手动删除 Sub2API 账号记录（不可逆）。 */
      enqueueDeleteSub2api: protectedProcedure
        .input(z.object({ accountId: z.string().min(1) }))
        .mutation(({ ctx, input }) => {
          const acc = ctx.repo.getAccountById(input.accountId);
          if (!acc) throw new TRPCError({ code: "NOT_FOUND", message: "account not found" });
          if (!acc.externalId) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "account has no external_id; nothing to delete on Sub2API"
            });
          }
          const now = new Date().toISOString();
          ctx.repo.enqueueAccountJob({
            id: randomUUID(),
            kind: "delete_sub2api",
            accountId: acc.id,
            status: "queued",
            attempt: 0,
            maxAttempts: 1,
            priority: 40,
            scheduledAt: now,
            startedAt: null,
            finishedAt: null,
            durationMs: null,
            payloadJson: JSON.stringify({}),
            resultJson: null,
            errorMessage: null,
            triggeredBy: "manual",
            triggeredTickId: null,
            createdAt: now,
            updatedAt: now
          });
          if (ctx.accountJobsWorker) void ctx.accountJobsWorker.pump().catch(() => undefined);
          return { enqueued: true };
        }),
      /** 标记账号永久弃用（origin=retired_legacy），仅本地不动 Sub2API。 */
      markRetiredLegacy: protectedProcedure
        .input(z.object({ accountId: z.string().min(1) }))
        .mutation(({ ctx, input }) => {
          const acc = ctx.repo.getAccountById(input.accountId);
          if (!acc) throw new TRPCError({ code: "NOT_FOUND", message: "account not found" });
          ctx.repo.patchAccount(acc.id, { origin: "retired_legacy", intent: "retired" });
          return { ok: true };
        })
    }),

    /**
     * 接管子路由（P5-AK/3）—— 系统页"codex-tool 账号接管"面板用。
     * 关键流程：用户上传 `accounts list --include-tokens` 的 JSON envelope，
     *   preview → 三分支去重 + summary（不入队）
     *   import  → 按 selectedIds 入队 import_codex_tool_account jobs
     */
    adoption: t.router({
      codexTool: t.router({
        /**
         * 解析上传的 envelope JSON，预览三分支去重计划。不入队，纯只读。
         * Sub2API 已配置时拉远端账号清单做匹配；未配置时空集兜底（仅本地匹配）。
         */
        preview: protectedProcedure
          .input(z.object({ envelopeJson: z.string().min(1) }))
          .mutation(async ({ ctx, input }) => {
            let codexAccounts;
            try {
              codexAccounts = parseCodexAccountListEnvelope(input.envelopeJson);
            } catch (err) {
              if (err instanceof CodexAdoptionParseError) {
                throw new TRPCError({
                  code: "BAD_REQUEST",
                  message: `codex-tool envelope 解析失败 (${err.kind}): ${err.message}`
                });
              }
              throw err;
            }
            const hiveAccounts = ctx.repo.listAccounts().map((a) => ({
              id: a.id,
              email: a.email,
              origin: a.origin,
              hasEncPhonePassword: Boolean(a.encPhone && a.encPassword),
              externalId: a.externalId
            }));
            // Sub2API 离线 / 未配置时静默 fallback，匹配只在本地做
            let sub2apiAccounts: Array<{ id: number; email: string | null }> = [];
            try {
              // status:"" 拉全量做去重匹配 —— 默认 status:"active" 在该 Sub2API 上返回 0，
              // 会让所有账号匹配不上 → 全判 register_new（产生 Sub2API 重复账号）。必须全量。
              const remote = await createConfiguredSub2ApiClient(ctx.repo).listAllAccounts(
                sub2ApiAccountFiltersSchema.parse({ status: "" })
              );
              sub2apiAccounts = remote.map((r) => ({
                id: r.id,
                email: r.credentials?.email ?? r.email ?? null
              }));
            } catch {
              // 静默 fallback：preview 中 Sub2API 视为无；用户能感知（summary 不会出 upgrade/skip）
            }
            const plan = planCodexToolAdoption({ codexAccounts, hiveAccounts, sub2apiAccounts });
            return { plan, sub2apiReachable: sub2apiAccounts.length > 0 || hiveAccounts.length === 0 };
          }),
        /**
         * 按 selectedExternalIds 入队 import_codex_tool_account job。
         * selectedExternalIds 为 codex-tool DB 的 account.id；未指定则导入 plan
         * 里所有 action != skip_* 的条目。
         */
        import: protectedProcedure
          .input(
            z.object({
              envelopeJson: z.string().min(1),
              selectedExternalIds: z.array(z.number().int().positive()).optional()
            })
          )
          .mutation(async ({ ctx, input }) => {
            // 解析 + 重做 plan（不信前端传 plan，保证后端一致）
            const codexAccounts = parseCodexAccountListEnvelope(input.envelopeJson);
            const hiveAccounts = ctx.repo.listAccounts().map((a) => ({
              id: a.id,
              email: a.email,
              origin: a.origin,
              hasEncPhonePassword: Boolean(a.encPhone && a.encPassword),
              externalId: a.externalId
            }));
            let sub2apiAccounts: Array<{ id: number; email: string | null }> = [];
            try {
              // 同 preview：status:"" 拉全量，否则匹配不上会重复建号。
              const remote = await createConfiguredSub2ApiClient(ctx.repo).listAllAccounts(
                sub2ApiAccountFiltersSchema.parse({ status: "" })
              );
              sub2apiAccounts = remote.map((r) => ({ id: r.id, email: r.credentials?.email ?? r.email ?? null }));
            } catch {
              // 静默；后续 import_codex_tool_account worker 会按 plan 处理
            }
            const plan = planCodexToolAdoption({ codexAccounts, hiveAccounts, sub2apiAccounts });
            const selectedSet = input.selectedExternalIds ? new Set(input.selectedExternalIds) : null;
            const toEnqueue = plan.items.filter((item) => {
              if (item.action === "skip_already_hive" || item.action === "skip_creds_complete") return false;
              if (selectedSet && !selectedSet.has(item.source.id)) return false;
              return true;
            });
            const now = new Date().toISOString();
            const jobIds: string[] = [];
            for (const item of toEnqueue) {
              const jobId = randomUUID();
              ctx.repo.enqueueAccountJob({
                id: jobId,
                kind: "import_codex_tool_account",
                accountId: item.hiveLocalId ?? null,
                status: "queued",
                attempt: 0,
                maxAttempts: 1,
                priority: 60,
                scheduledAt: now,
                startedAt: null,
                finishedAt: null,
                durationMs: null,
                payloadJson: JSON.stringify({
                  action: item.action,
                  reason: item.reason,
                  sub2apiAccountId: item.sub2apiAccountId ?? null,
                  source: item.source
                }),
                resultJson: null,
                errorMessage: null,
                triggeredBy: "adopter",
                triggeredTickId: null,
                createdAt: now,
                updatedAt: now
              });
              jobIds.push(jobId);
            }
            if (ctx.accountJobsWorker) void ctx.accountJobsWorker.pump().catch(() => undefined);
            return { enqueued: jobIds.length, jobIds };
          })
      })
    })
  })
});

function toAccountView(a: import("@mihomo-hive/schemas").AccountRecordInternal): AccountRecordView {
  return {
    id: a.id,
    externalId: a.externalId,
    origin: a.origin,
    intent: a.intent,
    health: a.health,
    email: a.email,
    organizationId: a.organizationId,
    platform: a.platform,
    hasPhonePassword: Boolean(a.encPhone && a.encPassword),
    hasRefreshToken: Boolean(a.encRefreshToken),
    lastObservedAt: a.lastObservedAt,
    lastUsedAt: a.lastUsedAt,
    rateLimitedAt: a.rateLimitedAt,
    rateLimitResetAt: a.rateLimitResetAt,
    quota5hPercent: a.quota5hPercent,
    quota7dPercent: a.quota7dPercent,
    errorsInWindow: a.errorsInWindow,
    brokenSinceTick: a.brokenSinceTick,
    recoveryAttempts: a.recoveryAttempts,
    nextRecoveryAfter: a.nextRecoveryAfter,
    lastRecoveryError: a.lastRecoveryError,
    lastRecoveryPath: a.lastRecoveryPath,
    lastRecoveryFailureCategory: a.lastRecoveryFailureCategory,
    opsEnabled: a.opsEnabled,
    herosmsActivationId: a.herosmsActivationId,
    batchId: a.batchId,
    registeredAt: a.registeredAt,
    smsCountry: a.smsCountry,
    smsCostCents: a.smsCostCents,
    egressNodeHash: a.egressNodeHash,
    firstSeenAt: a.firstSeenAt,
    reloginCount: a.reloginCount,
    lastRecoveredAt: a.lastRecoveredAt,
    changeHistory: a.changeHistory ?? [],
    createdAt: a.createdAt,
    updatedAt: a.updatedAt
  };
}

/**
 * P6-05 失败原因聚合：把最近失败 job 的(已归因)错误消息归类计数，降序返回。
 * 让用户一眼看到"主要卡在哪"，不必逐条展开日志。
 */
type FailureReasonKey =
  | "deactivated"
  | "consent"
  | "sentinel"
  | "ratelimit"
  | "region"
  | "otp"
  | "network"
  | "retired"
  | "oauth"
  | "other";

function aggregateFailureReasons(messages: string[]): Array<{ key: FailureReasonKey; count: number }> {
  const counts: Record<string, number> = {};
  for (const raw of messages) {
    const m = raw.toLowerCase();
    let key: FailureReasonKey;
    // 顺序：最确定/最具体在前。归因依据实测真实失败信号（2026-05-31）。
    if (
      // OpenAI 明确"账号已删除/停用"= 真死（email-otp/validate 403）。
      m.includes("deleted or deactivated") || m.includes("deactivated") || m.includes("do not have an account") ||
      m.includes("account_unusable") || m.includes("revoked") || m.includes("invalidated oauth")
    ) {
      key = "deactivated";
    } else if (m.includes("too many") || m.includes("稍后再试") || m.includes("rate limit")) {
      // OpenAI 限流（反复校验 OTP / 频繁登录触发），账号没坏，等待后可再试。
      key = "ratelimit";
    } else if (m.includes("地区不可用") || m.includes("no_numbers") || m.includes("没有可用号码") || m.includes("取不到号")) {
      key = "region";
    } else if (m.includes("缺少目标") || m.includes("没有 code") || m.includes("consent")) {
      // 活账号（过了 OpenAI OTP）但我方出口过不了 OAuth consent —— 非账号死，换干净出口可救。
      key = "consent";
    } else if (m.includes("sentinel") || m.includes("环境校验") || m.includes("提取失败") || m.includes("err_connection")) {
      // 浏览器相位过 Cloudflare Sentinel 失败 / 浏览器到 OpenAI 连接被重置（多为出口问题）。
      key = "sentinel";
    } else if (m.includes("邮箱验证码") || m.includes("email-otp") || m.includes("email otp")) {
      key = "otp";
    } else if (
      m.includes("代理") || m.includes("proxy") || m.includes("tls") || m.includes("curl") ||
      m.includes("timed out") || m.includes("timeout") || m.includes("connection") || m.includes("network") ||
      m.includes("网络") || m.includes("fetch failed")
    ) {
      key = "network";
    } else if (m.includes("已退役") || m.includes("retired") || m.includes("跳过")) {
      key = "retired";
    } else if (m.includes("oauth")) {
      key = "oauth";
    } else {
      key = "other";
    }
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([key, count]) => ({ key: key as FailureReasonKey, count }))
    .sort((a, b) => b.count - a.count);
}

function budgetWindowKeyUtc(at: Date, kind: "day" | "month"): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, "0");
  if (kind === "month") return `${y}-${m}-month`;
  const d = String(at.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}-day`;
}

export type AppRouter = typeof appRouter;

async function applySub2ApiAssignment(repo: HiveRepository, input: z.infer<typeof sub2ApiAssignmentOptionsSchema>) {
  const client = createConfiguredSub2ApiClient(repo);
  const [proxies, accounts] = await Promise.all([client.listAllProxies(), client.listAllAccounts(input.filters)]);
  const preview = planSub2ApiAssignments({ proxies, accounts, options: input });
  if (preview.errors.length > 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: preview.errors.join("；") });
  }

  const results = [];
  const successIds: number[] = [];
  const failedIds: number[] = [];
  for (const batch of groupAssignmentChangesByProxy(preview.changes)) {
    const result = await client.bulkUpdateProxy(batch.accountIds, batch.proxyId);
    successIds.push(...result.successIds);
    failedIds.push(...result.failedIds);
    for (const item of result.results) {
      results.push({ ...item, proxyId: batch.proxyId });
    }
    for (const id of result.successIds) {
      if (!results.some((item) => item.accountId === id)) {
        results.push({ accountId: id, proxyId: batch.proxyId, success: true });
      }
    }
    for (const id of result.failedIds) {
      if (!results.some((item) => item.accountId === id)) {
        results.push({ accountId: id, proxyId: batch.proxyId, success: false });
      }
    }
  }

  const finalSuccessIds = Array.from(new Set([...successIds, ...results.filter((item) => item.success).map((item) => item.accountId)]));
  const finalFailedIds = Array.from(new Set([...failedIds, ...results.filter((item) => !item.success).map((item) => item.accountId)]));
  return sub2ApiAssignmentApplyResultSchema.parse({
    preview,
    success: finalSuccessIds.length,
    failed: finalFailedIds.length,
    successIds: finalSuccessIds,
    failedIds: finalFailedIds,
    results
  });
}

function summarizeSubscription(source: SubscriptionSource) {
  const { lastContent, ...safeSource } = source;
  return {
    ...safeSource,
    value: source.kind === "url" ? redactUrl(source.value) : source.value,
    fetched: Boolean(lastContent),
    ...(lastContent ? { lastContentBytes: lastContent.length } : {})
  };
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = url.search ? "?..." : "";
    return url.toString();
  } catch {
    return "<redacted>";
  }
}

function resolvePreviewSource(
  repo: HiveRepository,
  input: { id?: string | undefined; name?: string | undefined; url?: string | undefined }
): SubscriptionSource {
  if (input.id) {
    const source = repo.listSubscriptions().find((item) => item.id === input.id);
    if (source) return source;
    // 容错：id 找不到时，若带了 url 就走临时源（预览本就不要求订阅已保存）。
    // 修复"输 URL→预览→加关键词→重新预览"报"订阅源不存在"——首次预览的 source.id
    // 只是个未保存的随机 UUID，重新预览传它回来当然找不到。
    if (!input.url) {
      throw new TRPCError({ code: "NOT_FOUND", message: "订阅源不存在。" });
    }
  }
  if (!input.name || !input.url) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "请填写订阅名称和 URL。" });
  }
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: input.name,
    kind: "url",
    value: input.url,
    enabled: true,
    excludeKeywords: [],
    createdAt: now,
    updatedAt: now
  };
}

async function fetchSourceContent(repo: HiveRepository, source: SubscriptionSource): Promise<string> {
  return repo.fetchSubscriptionContent(source);
}

function selectNodes(nodes: ProxyNode[], hashes: string[]): ProxyNode[] {
  const wanted = new Set(hashes);
  const selected = nodes.filter((node) => wanted.has(node.hash));
  if (selected.length !== hashes.length) {
    throw new TRPCError({ code: "NOT_FOUND", message: "部分节点不存在。" });
  }
  return selected;
}

async function loadSub2ApiSnapshot(repo: HiveRepository): Promise<{
  client?: ReturnType<typeof createSub2ApiClient>;
  proxies: Sub2ApiProxyRecord[];
  accounts: Sub2ApiAccountRecord[];
}> {
  const connection = repo.getSub2ApiConnection();
  if (!connection) {
    return { proxies: [], accounts: [] };
  }
  const client = createSub2ApiClient(connection);
  const [proxies, accounts] = await Promise.all([client.listAllProxies(), client.listAllAccounts(sub2ApiAccountFiltersSchema.parse({ status: "" }))]);
  return { client, proxies, accounts };
}

async function writeGenerated(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function createConfiguredSub2ApiClient(repo: HiveRepository) {
  const connection = repo.getSub2ApiConnection();
  if (!connection) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "请先配置 Sub2API 地址和管理员 API Key。" });
  }
  return createSub2ApiClient(connection);
}

function matchesProtectedProxyLike(proxy: Sub2ApiProxyRecord, rule: Sub2ApiProtectedProxyRule): boolean {
  return (
    rule.proxyIds.includes(proxy.id) ||
    includesText(proxy.name, rule.nameIncludes) ||
    includesText(proxy.host, rule.hostIncludes) ||
    (Boolean(rule.port) && proxy.port === rule.port) ||
    includesText(proxy.country ?? "", rule.countryIncludes) ||
    includesText(proxy.region ?? "", rule.regionIncludes) ||
    (rule.status.length > 0 && proxy.status === rule.status)
  );
}

function includesText(value: string, expected: string): boolean {
  return expected.length > 0 && value.toLowerCase().includes(expected.toLowerCase());
}

function createJob(type: string, title: string, detail: string, stepNames: string[] = []): OperationJob {
  const now = new Date().toISOString();
  const job: OperationJob = {
    id: randomUUID(),
    type,
    title,
    detail,
    status: "running",
    steps: stepNames.map((name) => ({ name, status: "queued", detail: "" })),
    createdAt: now,
    updatedAt: now
  };
  operationJobs.set(job.id, job);
  return job;
}

function updateJobStep(id: string, index: number, status: OperationJobStatus, detail: string): void {
  const job = operationJobs.get(id);
  if (!job?.steps[index]) {
    return;
  }
  job.steps[index] = { ...job.steps[index], status, detail };
  job.updatedAt = new Date().toISOString();
  operationJobs.set(id, job);
}

function finishJob(id: string, status: OperationJobStatus, detail: string): void {
  const job = operationJobs.get(id);
  if (!job) {
    return;
  }
  job.status = status;
  job.detail = detail;
  job.updatedAt = new Date().toISOString();
  operationJobs.set(id, job);
}
