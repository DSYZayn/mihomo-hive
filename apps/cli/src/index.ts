#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import {
  assignStablePorts,
  createSub2ApiClient,
  enumeratePorts,
  findOccupiedPorts,
  filterPreviewImportableNodes,
  hashPassword,
  loadRuntimeConfig,
  localProbeHost,
  mapWithConcurrency,
  measureProxyTcpLatency,
  parsePortRange,
  planSub2ApiAssignments,
  renderMihomoConfig,
  resolveProxyTestTargets,
  resolveConfigPath,
  testProxyTarget,
  writeRuntimeConfig
} from "@mihomo-hive/core";
import { openSqlite, HiveRepository } from "@mihomo-hive/db";
import { exportSub2Api } from "@mihomo-hive/exporters";
import { readMihomoStatus, reloadMihomo, startMihomo, stopMihomo } from "@mihomo-hive/mihomo";
import { defaultRuntimeConfig, parseRuntimeConfig, sub2ApiAccountFiltersSchema, sub2ApiProtectedProxyRuleSchema } from "@mihomo-hive/schemas";
import type { Sub2ApiAssignmentOptions, SubscriptionSource } from "@mihomo-hive/schemas";

const program = new Command();

program.name("hive").description("Mihomo Hive fixed-egress proxy pool manager").version("0.1.0");

program
  .command("init")
  .description("Create a default runtime config")
  .option("--config <path>", "Config path")
  .option("--listen-host <host>", "Mihomo listener bind host", "127.0.0.1")
  .option("--export-host <host>", "Host written to Sub2API exports", "127.0.0.1")
  .option("--range <range>", "Port range", "10001-10300")
  .action(async (options) => {
    const range = parsePortRange(options.range as string);
    const config = parseRuntimeConfig({
      ...defaultRuntimeConfig,
      listenHost: options.listenHost,
      exportHost: options.exportHost,
      portRangeStart: range.start,
      portRangeEnd: range.end
    });
    await writeRuntimeConfig(config, options.config ?? resolveConfigPath());
    console.log(`Created config: ${options.config ?? resolveConfigPath()}`);
  });

const auth = program.command("auth").description("Manage local access password");

auth
  .command("status")
  .description("Show whether an access password is configured")
  .action(async () => {
    const { repo } = await openRepo();
    console.log(JSON.stringify({ configured: repo.hasPassword() }, null, 2));
  });

auth
  .command("reset-password")
  .description("Reset the Web UI/API access password and revoke sessions")
  .option("--password <password>", "New password")
  .option("--password-stdin", "Read the new password from stdin")
  .action(async (options) => {
    const { repo } = await openRepo();
    const password = await readPasswordOption(options);
    repo.resetPassword(await hashPassword(password));
    console.log("Password reset; all sessions revoked.");
  });

const sub = program.command("sub").description("Manage subscriptions");

sub
  .command("add")
  .requiredOption("--name <name>", "Subscription name")
  .option("--url <url>", "Subscription URL")
  .option("--file <file>", "Subscription file")
  .action(async (options) => {
    if (!options.url && !options.file) {
      throw new Error("Provide --url or --file");
    }
    const { repo } = await openRepo();
    const source = repo.addSubscription({
      id: randomUUID(),
      name: options.name,
      kind: options.url ? "url" : "file",
      value: options.url ?? options.file
    });
    console.log(
      JSON.stringify(
        {
          ...source,
          value: source.kind === "url" ? redactUrl(source.value) : source.value
        },
        null,
        2
      )
    );
  });

sub
  .command("list")
  .description("List subscriptions")
  .action(async () => {
    const { repo } = await openRepo();
    console.log(JSON.stringify(repo.listSubscriptions().map(summarizeSubscription), null, 2));
  });

sub
  .command("fetch")
  .description("Fetch enabled subscriptions")
  .action(async () => {
    const { repo } = await openRepo();
    const sources = repo.listSubscriptions().filter((source) => source.enabled);
    for (const source of sources) {
      const content = await repo.fetchSubscriptionContent(source);
      repo.updateSubscriptionContent(source.id, content);
      console.log(`Fetched ${source.name}: ${content.length} bytes`);
    }
  });

const nodes = program.command("nodes").description("Manage nodes");

nodes
  .command("import")
  .description("Parse fetched subscription content and upsert nodes")
  .action(async () => {
    const { repo } = await openRepo();
    repo.deduplicateNodesByIdentity();
    let imported = 0;
    for (const source of repo.listSubscriptions().filter((item) => item.enabled)) {
      const content = source.lastContent ?? (await repo.fetchSubscriptionContent(source));
      const nodes = filterPreviewImportableNodes({
        source,
        content,
        existingNodes: repo.listNodes(),
        excludeKeywords: source.excludeKeywords
      });
      repo.upsertNodes(nodes);
      imported += nodes.length;
      console.log(`Imported ${nodes.length} nodes from ${source.name}`);
    }
    const deduplicated = repo.deduplicateNodesByIdentity();
    console.log(`Total imported: ${imported}`);
    if (deduplicated > 0) console.log(`Merged duplicates: ${deduplicated}`);
  });

nodes
  .command("list")
  .description("List normalized nodes")
  .option("--json", "Print full JSON")
  .action(async (options) => {
    const { repo } = await openRepo();
    const all = repo.listNodes();
    if (options.json) {
      console.log(JSON.stringify(all, null, 2));
      return;
    }
    for (const node of all) {
      console.log(
        `${node.assignedPort ?? "-"}\t${node.status}\t${node.region}\t${node.type}\t${node.name}\t${node.hash.slice(0, 8)}`
      );
    }
  });

nodes
  .command("test")
  .description("Test assigned local listener ports and update node status")
  .option("--targets <targets>", "Comma-separated test targets: ip,openai,claude", "openai")
  .option("--host <host>", "Listener host to test")
  .option("--timeout-ms <ms>", "Per-target timeout", parseIntegerOption, 15_000)
  .option("--concurrency <n>", "Parallel node tests", parseIntegerOption, 8)
  .action(async (options) => {
    const { config, repo } = await openRepo();
    const targets = resolveProxyTestTargets(
      String(options.targets)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    );
    const host = localProbeHost(options.host ?? config.listenHost);
    const candidates = repo.listNodes().filter((node) => node.assignedPort);
    const tested = await mapWithConcurrency(candidates, options.concurrency, async (node) => {
      // 普通节点测直连 L1；链式节点的所有健康信号都来自下面经 listener
      // 发出的整链请求，不能绕过第一跳直测最终节点。
      const rawHost = node.kind !== "chain" && typeof node.raw?.server === "string" ? node.raw.server : null;
      const rawPort = node.kind !== "chain" && typeof node.raw?.port === "number" ? node.raw.port : null;
      const l1 =
        rawHost && rawPort
          ? await measureProxyTcpLatency({ host: rawHost, port: rawPort, timeoutMs: options.timeoutMs })
          : { latencyMs: 0, error: "no_raw_endpoint" };

      const results = [];
      for (const target of targets) {
        results.push(
          await testProxyTarget({
            host,
            port: Number(node.assignedPort),
            target,
            timeoutMs: options.timeoutMs
          })
        );
      }
      const passed = results.every((result) => result.ok);
      const statusText = results
        .map((result) => `${result.targetId}:${result.httpStatus ?? result.message}`)
        .join(",");
      const targetMaxLatency = Math.max(...results.map((result) => result.latencyMs));
      const reportedLatency = node.kind === "chain" ? targetMaxLatency : l1.latencyMs;
      console.log(`${node.assignedPort}\t${passed ? "pass" : "fail"}\tlatency=${reportedLatency}ms\t${statusText}\t${node.name}`);
      return {
        ...node,
        status: passed ? ("active" as const) : ("failed" as const),
        lastTestStatus: statusText,
        lastTestLatencyMs: reportedLatency,
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
    });
    repo.saveNodes(tested);
    console.log(`Tested ${tested.length} nodes; passed: ${tested.filter((node) => node.status === "active").length}`);
  });

const ports = program.command("ports").description("Manage local egress ports");

ports
  .command("assign")
  .description("Assign stable ports to schedulable nodes (use 'nodes enable-candidates' first to promote new imports)")
  .option("--range <range>", "Port range override")
  .option("--skip-port-check", "Do not probe occupied ports")
  .option("--include-candidates", "Promote untested candidates before assigning (equivalent to running 'nodes enable-candidates' first)")
  .action(async (options) => {
    const { config, repo } = await openRepo();
    if (options.includeCandidates) {
      repo.setAllUntestedActive();
    }
    const range = options.range
      ? parsePortRange(options.range)
      : { start: config.portRangeStart, end: config.portRangeEnd };
    const portList = enumeratePorts(range);
    const occupied = options.skipPortCheck ? new Set<number>() : await findOccupiedPorts(config.listenHost, portList);
    const nodesWithPorts = assignStablePorts({
      nodes: repo.listNodes(),
      range,
      occupiedPorts: occupied,
      preserveExisting: false
    });
    repo.saveNodes(nodesWithPorts);
    const assigned = nodesWithPorts.filter((node) => node.assignedPort).length;
    console.log(`Assigned ${assigned} ports in ${range.start}-${range.end}; occupied skipped: ${occupied.size}`);
  });

nodes
  .command("enable-candidates")
  .description("Promote all untested/candidate nodes to schedulable so they can receive ports")
  .action(async () => {
    const { repo } = await openRepo();
    repo.setAllUntestedActive();
    const promoted = repo.listNodes().filter((node) => node.lifecycleStatus === "schedulable" && !node.assignedPort).length;
    console.log(`Promoted ${promoted} candidate(s) to schedulable. Run 'ports assign' to allocate ports.`);
  });

nodes
  .command("reset-intent")
  .description("Reset orchestration intent (clear quarantine/evicted state) so reconcile re-evaluates")
  .option("--all-evicted", "Target all nodes whose intentRole is evicted/quarantined", false)
  .option("--all-retired", "Target all nodes whose lifecycleStatus is retired", false)
  .option("--hash <hash...>", "Specific node hashes to reset")
  .option("--no-lift-retired", "Do not auto-lift retired nodes back to schedulable")
  .action(async (options) => {
    const { repo } = await openRepo();
    const all = repo.listNodes();
    const targets = new Set<string>();
    if (Array.isArray(options.hash)) {
      for (const h of options.hash as string[]) targets.add(h);
    }
    if (options.allEvicted) {
      for (const n of all) {
        if (n.intentRole === "evicted" || n.intentRole === "quarantined") targets.add(n.hash);
      }
    }
    if (options.allRetired) {
      for (const n of all) {
        if (n.lifecycleStatus === "retired") targets.add(n.hash);
      }
    }
    if (targets.size === 0) {
      console.log("No targets. Use --hash <hash...> / --all-evicted / --all-retired.");
      return;
    }
    const hashList = Array.from(targets);
    const liftRetired = options.liftRetired !== false;
    const retired = all.filter((n) => targets.has(n.hash) && n.lifecycleStatus === "retired").map((n) => n.hash);
    if (liftRetired && retired.length > 0) {
      repo.markNodesLifecycle(retired, "schedulable");
    }
    const reset = repo.resetNodeIntent(hashList);
    console.log(
      `Reset ${reset.length} node(s); lifted ${liftRetired ? retired.length : 0} from retired. Reconcile will re-evaluate within the next tick.`
    );
  });

const mihomo = program.command("mihomo").description("Render and control Mihomo");

mihomo
  .command("render")
  .description("Render generated/mihomo.yaml and egress-map.json")
  .action(async () => {
    const { config, repo } = await openRepo();
    const rendered = renderMihomoConfig(repo.listNodes(), config);
    await writeGenerated(config.mihomoConfigPath, rendered.yaml);
    await writeGenerated(`${config.generatedDir}/egress-map.json`, JSON.stringify(rendered.egressMap, null, 2));
    console.log(`Rendered ${rendered.egressMap.length} listeners to ${config.mihomoConfigPath}`);
  });

mihomo.command("start").action(async () => console.log(JSON.stringify(await startMihomo((await openRepo()).config), null, 2)));
mihomo.command("stop").action(async () => console.log(JSON.stringify(await stopMihomo((await openRepo()).config), null, 2)));
mihomo.command("reload").action(async () => console.log(JSON.stringify(await reloadMihomo((await openRepo()).config), null, 2)));
mihomo.command("status").action(async () => console.log(JSON.stringify(await readMihomoStatus((await openRepo()).config), null, 2)));

const exportCommand = program.command("export").description("Export generated formats");

exportCommand
  .command("sub2api")
  .description("Export Sub2API-compatible proxy JSON")
  .option("--host <host>", "Host written to proxy entries")
  .option("--output <file>", "Output file", "generated/sub2api-proxies.json")
  .option("--failed-node-status <status>", "Status for failed nodes: active or inactive", "inactive")
  .action(async (options) => {
    const { config, repo } = await openRepo();
    const payload = exportSub2Api(repo.listNodes(), {
      host: options.host ?? config.exportHost,
      failedNodeStatus: options.failedNodeStatus
    });
    await writeGenerated(options.output, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`Exported ${payload.proxies.length} proxies to ${options.output}`);
  });

const sub2api = program.command("sub2api").description("Manage Sub2API integration");

sub2api
  .command("config")
  .description("Save Sub2API URL and admin API key")
  .requiredOption("--base-url <url>", "Sub2API base URL")
  .requiredOption("--api-key <key>", "Sub2API admin API key")
  .option("--timezone <timezone>", "Sub2API timezone", "Asia/Shanghai")
  .option("--managed-proxy-prefix <prefix>", "Prefix used to identify Mihomo Hive managed proxies", "MH-")
  .action(async (options) => {
    const { repo } = await openRepo();
    repo.setSub2ApiConnection({
      baseUrl: options.baseUrl,
      adminApiKey: options.apiKey,
      timezone: options.timezone,
      managedProxyPrefix: options.managedProxyPrefix
    });
    console.log(JSON.stringify(repo.getSafeSub2ApiConnection(), null, 2));
  });

sub2api
  .command("test")
  .description("Test Sub2API connection")
  .action(async () => {
    const client = createStoredSub2ApiClient((await openRepo()).repo);
    console.log(JSON.stringify(await client.testConnection(), null, 2));
  });

sub2api
  .command("preview")
  .description("Preview account to proxy assignment")
  .option("--platform <platform>", "Account platform", "openai")
  .option("--status <status>", "Account status", "active")
  .option("--type <type>", "Account type", "")
  .option("--group <group>", "Account group", "")
  .option("--search <search>", "Account search", "")
  .option("--protect-proxy-ids <ids>", "Comma-separated protected Sub2API proxy IDs", "")
  .option("--protect-name <text>", "Protect proxies whose name contains text", "")
  .option("--overwrite-existing", "Reassign non-protected accounts even when they already have an assignable proxy")
  .action(async (options) => {
    const { repo } = await openRepo();
    const preview = await previewSub2ApiAssignments(repo, buildSub2ApiAssignmentOptions(options));
    console.log(JSON.stringify(preview, null, 2));
  });

sub2api
  .command("apply")
  .description("Apply account to proxy assignment through Sub2API bulk-update")
  .option("--platform <platform>", "Account platform", "openai")
  .option("--status <status>", "Account status", "active")
  .option("--type <type>", "Account type", "")
  .option("--group <group>", "Account group", "")
  .option("--search <search>", "Account search", "")
  .option("--protect-proxy-ids <ids>", "Comma-separated protected Sub2API proxy IDs", "")
  .option("--protect-name <text>", "Protect proxies whose name contains text", "")
  .option("--overwrite-existing", "Reassign non-protected accounts even when they already have an assignable proxy")
  .action(async () => {
    throw new Error("账号代理自动迁移已禁用。Mihomo Hive 只验活节点并幂等推送代理，不会更换账号出口。");
  });

// ─────────── 账号编排(fleet)CLI —— 供 AI/自动化直接驱动,无需网页登录态 ───────────
// 直接写 repo/DB;运行中的 server worker 通过 poll 循环消费入队的 job,无需 pump。
const fleet = program.command("fleet").description("账号编排:状态/停起运维/注册/登录/导入(供自动维护)");

function enqueueFleetJob(
  repo: HiveRepository,
  kind: "codex_login" | "codex_register" | "import_to_sub2api",
  opts: { accountId?: string | null; priority?: number; payload?: unknown }
): void {
  const now = new Date().toISOString();
  repo.enqueueAccountJob({
    id: randomUUID(),
    kind,
    accountId: opts.accountId ?? null,
    status: "queued",
    attempt: 0,
    maxAttempts: 1,
    priority: opts.priority ?? 50,
    scheduledAt: now,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    payloadJson: JSON.stringify(opts.payload ?? { reason: "cli" }),
    resultJson: null,
    errorMessage: null,
    triggeredBy: "manual",
    triggeredTickId: null,
    createdAt: now,
    updatedAt: now
  });
}

fleet
  .command("status")
  .description("概览:意图/健康/运维开关分布 + 队列 + 可恢复数")
  .action(async () => {
    const { repo } = await openRepo();
    const accs = repo.listAccounts();
    const by = (f: (a: (typeof accs)[number]) => string) => {
      const m: Record<string, number> = {};
      for (const a of accs) m[f(a)] = (m[f(a)] ?? 0) + 1;
      return m;
    };
    const now = Date.now();
    const eligibleRecover = accs.filter(
      (a) =>
        a.health === "broken" &&
        a.intent === "recovering" &&
        a.opsEnabled !== false &&
        (!a.nextRecoveryAfter || new Date(a.nextRecoveryAfter).getTime() <= now)
    ).length;
    console.log(
      JSON.stringify(
        {
          total: accs.length,
          intent: by((a) => a.intent),
          health: by((a) => a.health),
          opsEnabled: by((a) => (a.opsEnabled === false ? "off" : "on")),
          queuedJobs: repo.countQueuedAccountJobs(),
          eligibleRecoverNow: eligibleRecover
        },
        null,
        2
      )
    );
  });

fleet
  .command("accounts")
  .description("列出账号(脱敏:id前缀/意图/健康/运维/失败类/激活ID/邮箱)")
  .option("--intent <intent>", "按意图过滤")
  .option("--ops <state>", "按运维开关过滤 on/off")
  .option("--broken", "只看 broken")
  .option("--limit <n>", "最多显示", "40")
  .action(async (o) => {
    const { repo } = await openRepo();
    let accs = repo.listAccounts();
    if (o.intent) accs = accs.filter((a) => a.intent === o.intent);
    if (o.ops) accs = accs.filter((a) => (a.opsEnabled === false ? "off" : "on") === o.ops);
    if (o.broken) accs = accs.filter((a) => a.health === "broken");
    const limit = Number(o.limit) || 40;
    for (const a of accs.slice(0, limit)) {
      console.log(
        [
          a.id,
          a.intent,
          a.health,
          a.opsEnabled === false ? "ops:off" : "ops:on",
          a.lastRecoveryFailureCategory ?? "-",
          a.herosmsActivationId ?? "-",
          a.email
        ].join("\t")
      );
    }
    console.log(`# 显示 ${Math.min(accs.length, limit)} / 共 ${accs.length}`);
  });

fleet
  .command("stop-all")
  .description("停掉账号运维并清其队列任务。默认只停非 active;--include-active 全停")
  .option("--include-active", "连 active 一起停", false)
  .action(async (o) => {
    const { repo } = await openRepo();
    console.log(JSON.stringify(repo.setAllOpsEnabled(false, { onlyNonActive: !o.includeActive })));
  });

fleet
  .command("start-all")
  .description("恢复所有账号运维开关")
  .action(async () => {
    const { repo } = await openRepo();
    console.log(JSON.stringify(repo.setAllOpsEnabled(true, { onlyNonActive: false })));
  });

fleet
  .command("ops <accountId> <state>")
  .description("单账号运维开关 on/off(off 同时清该账号队列任务)")
  .action(async (accountId: string, state: string) => {
    const { repo } = await openRepo();
    const acc = repo.setAccountOpsEnabled(accountId, state === "on");
    if (!acc) {
      console.error("account not found");
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ id: acc.id, opsEnabled: acc.opsEnabled }));
  });

fleet
  .command("register <count>")
  .description("入队 N 个 codex_register(立即注册新号),默认插队")
  .option("--no-jump", "不插队(priority=80 而非 5)")
  .action(async (count: string, o: { jump?: boolean }) => {
    const { repo } = await openRepo();
    const n = Math.max(1, Math.min(50, Number(count) || 1));
    const priority = o.jump === false ? 80 : 5;
    for (let i = 0; i < n; i++) enqueueFleetJob(repo, "codex_register", { priority, payload: { reason: "cli", batch: n } });
    console.log(JSON.stringify({ enqueued: n, priority }));
  });

fleet
  .command("login <accountId>")
  .description("入队一次 codex_login(要求账号有 phone+password)")
  .action(async (accountId: string) => {
    const { repo } = await openRepo();
    const acc = repo.getAccountById(accountId);
    if (!acc) {
      console.error("account not found");
      process.exitCode = 1;
      return;
    }
    if (!acc.encPhone || !acc.encPassword) {
      console.error("account lacks phone/password; cannot run codex_login");
      process.exitCode = 1;
      return;
    }
    enqueueFleetJob(repo, "codex_login", { accountId: acc.id, priority: 50, payload: { reason: "cli" } });
    console.log(JSON.stringify({ enqueued: true, accountId: acc.id }));
  });

fleet
  .command("import <refreshToken>")
  .description("入队 import_to_sub2api(用 refresh_token 把账号导入平台、进真实调度)")
  .option("--existing <accountId>", "关联到已有账号 id(复活)")
  .action(async (refreshToken: string, o: { existing?: string }) => {
    const { repo } = await openRepo();
    enqueueFleetJob(repo, "import_to_sub2api", {
      accountId: o.existing ?? null,
      priority: 60,
      payload: { refreshToken, existingAccountId: o.existing }
    });
    console.log(JSON.stringify({ enqueued: true }));
  });

async function openRepo() {
  const config = await loadRuntimeConfig();
  const sqlite = openSqlite(config.databasePath);
  return {
    config,
    sqlite,
    repo: new HiveRepository(sqlite, { subscriptionUserAgent: config.subscriptionUserAgent })
  };
}

function createStoredSub2ApiClient(repo: HiveRepository) {
  const connection = repo.getSub2ApiConnection();
  if (!connection) {
    throw new Error("请先运行 hive sub2api config 配置 Sub2API。");
  }
  return createSub2ApiClient(connection);
}

async function previewSub2ApiAssignments(repo: HiveRepository, options: Sub2ApiAssignmentOptions) {
  const client = createStoredSub2ApiClient(repo);
  const [proxies, accounts] = await Promise.all([
    client.listAllProxies(),
    client.listAllAccounts(options.filters)
  ]);
  return planSub2ApiAssignments({ proxies, accounts, options });
}

function buildSub2ApiAssignmentOptions(options: Record<string, unknown>): Sub2ApiAssignmentOptions {
  return {
    filters: sub2ApiAccountFiltersSchema.parse({
      platform: options.platform,
      status: options.status,
      type: options.type,
      group: options.group,
      search: options.search
    }),
    protectedRule: sub2ApiProtectedProxyRuleSchema.parse({
      proxyIds: parseIdList(String(options.protectProxyIds ?? "")),
      nameIncludes: String(options.protectName ?? "")
    }),
    overwriteExisting: Boolean(options.overwriteExisting)
  };
}

function parseIdList(value: string): number[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const id = Number(item);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error(`Invalid proxy id: ${item}`);
      }
      return id;
    });
}

async function writeGenerated(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
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

function summarizeSubscription(source: SubscriptionSource) {
  const { lastContent, ...safeSource } = source;
  return {
    ...safeSource,
    value: source.kind === "url" ? redactUrl(source.value) : source.value,
    fetched: Boolean(lastContent),
    ...(lastContent ? { lastContentBytes: lastContent.length } : {})
  };
}

function parseIntegerOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer: ${value}`);
  }
  return parsed;
}

async function readPasswordOption(options: { password?: string; passwordStdin?: boolean }): Promise<string> {
  if (options.passwordStdin) {
    return (await readFile("/dev/stdin", "utf8")).trimEnd();
  }
  if (options.password) {
    return options.password;
  }
  if (process.env.HIVE_RESET_PASSWORD) {
    return process.env.HIVE_RESET_PASSWORD;
  }
  throw new Error("Provide --password, --password-stdin, or HIVE_RESET_PASSWORD");
}

// 所有命令(含 fleet)注册完毕后再解析,避免漏注册。
program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
