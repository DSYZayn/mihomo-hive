import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  loadRuntimeConfig,
  renderMihomoConfig,
  verifyPassword
} from "@mihomo-hive/core";
import { openSqlite, HiveRepository } from "@mihomo-hive/db";
import { exportSub2Api } from "@mihomo-hive/exporters";
import { readMihomoStatus, reloadMihomo, startMihomo } from "@mihomo-hive/mihomo";
import { sub2ApiExportRequestSchema } from "@mihomo-hive/schemas";
import { existsSync } from "node:fs";
import { codexEgressRenderOpts } from "./codex-egress.js";
import { startNodeMaintenanceScheduler } from "./orchestrator.js";
import { appRouter } from "./router.js";

const config = await loadRuntimeConfig();
const sqlite = openSqlite(config.databasePath);
const repo = new HiveRepository(sqlite, { subscriptionUserAgent: config.subscriptionUserAgent });
const app = new Hono();
const sessionCookieName = "mihomo_hive_session";
const sessionTtlSeconds = 60 * 60 * 24 * 30;

app.get("/health", (c) => c.json({ ok: true }));

app.get("/api/auth/status", async (c) =>
  c.json({
    configured: repo.hasPassword(),
    authenticated: await isAuthenticated(c.req.raw)
  })
);

app.post("/api/auth/setup", async (c) => {
  if (repo.hasPassword()) {
    return c.json({ error: "Password is already configured" }, 409);
  }
  const body = (await c.req.json().catch(() => ({}))) as { password?: unknown };
  if (typeof body.password !== "string") {
    return c.json({ error: "Password is required" }, 400);
  }
  repo.setPasswordHash(await hashPassword(body.password));
  createSession(c);
  return c.json({ ok: true });
});

app.post("/api/auth/login", async (c) => {
  const stored = repo.getPasswordHash();
  if (!stored) {
    return c.json({ error: "Password is not configured" }, 409);
  }
  const body = (await c.req.json().catch(() => ({}))) as { password?: unknown };
  if (typeof body.password !== "string" || !(await verifyPassword(body.password, stored))) {
    return c.json({ error: "Invalid password" }, 401);
  }
  createSession(c);
  return c.json({ ok: true });
});

app.post("/api/auth/logout", async (c) => {
  const token = getCookie(c, sessionCookieName);
  if (token) {
    repo.deleteSessionByTokenHash(hashSessionToken(token));
  }
  deleteCookie(c, sessionCookieName, { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/exports/sub2api", async (c) => {
  if (!(await isAuthenticated(c.req.raw))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const host = c.req.query("host") ?? config.exportHost;
  return c.json(exportSub2Api(repo.listNodes(), { host }));
});

app.post("/api/exports/sub2api/download", async (c) => {
  if (!(await isAuthenticated(c.req.raw))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const input = sub2ApiExportRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!input.success) {
    return c.json({ error: "Invalid export request", issues: input.error.issues }, 400);
  }
  const payload = exportSub2Api(repo.listNodes(), {
    host: input.data.host ?? config.exportHost,
    selectedHashes: input.data.selectedHashes,
    failedNodeStatus: input.data.failedNodeStatus,
    namePrefix: repo.getSub2ApiConnection()?.managedProxyPrefix
  });
  const filename = sanitizeDownloadFilename(input.data.filename);
  return new Response(`${JSON.stringify(payload, null, 2)}\n`, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`
    }
  });
});

app.post("/api/mihomo/render", async (c) => {
  if (!(await isAuthenticated(c.req.raw))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const rendered = renderMihomoConfig(repo.listNodes(), config, codexEgressRenderOpts(repo));
  await writeGenerated(config.mihomoConfigPath, rendered.yaml);
  await writeGenerated(`${config.generatedDir}/egress-map.json`, JSON.stringify(rendered.egressMap, null, 2));
  return c.json({ listeners: rendered.egressMap.length });
});

// 精简后台维护器：只做订阅刷新、节点验活和 Sub2API 代理幂等同步。
// 绝不读取或修改账号代理绑定，因此不会造成账号 IP 漂移。
const nodeMaintenanceScheduler =
  process.env.HIVE_DISABLE_MAINTENANCE === "true" ? undefined : startNodeMaintenanceScheduler({ repo, config });

app.use("/trpc/*", async (c) =>
  fetchRequestHandler({
    endpoint: "/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: async () => ({
      config,
      repo,
      authenticated: await isAuthenticated(c.req.raw),
      orchestrator: undefined,
      accountFleetScheduler: undefined,
      accountJobsWorker: undefined
    })
  })
);

const staticRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
app.use("/*", serveStatic({ root: staticRoot }));

const host = process.env.HIVE_HOST ?? "0.0.0.0";
const port = Number(process.env.HIVE_PORT ?? 9990);

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`Mihomo Hive listening on http://${info.address}:${info.port}`);
  void autoBootMihomo();
});

async function autoBootMihomo(): Promise<void> {
  if (process.env.HIVE_DISABLE_MIHOMO_AUTOBOOT === "true") {
    console.log("Mihomo auto-boot skipped (HIVE_DISABLE_MIHOMO_AUTOBOOT=true).");
    return;
  }
  // 启动时按当前节点 + spec 重渲染 mihomo.yaml,确保运行配置反映最新状态 ——
  // 尤其是外置 agent 的 codex-egress 唯一出口口(否则沿用旧配置,改了 spec 也不生效)。
  try {
    const rendered = renderMihomoConfig(repo.listNodes(), config, codexEgressRenderOpts(repo));
    await writeGenerated(config.mihomoConfigPath, rendered.yaml);
    await writeGenerated(`${config.generatedDir}/egress-map.json`, JSON.stringify(rendered.egressMap, null, 2));
    console.log(`Mihomo config rendered on boot (${rendered.egressMap.length} listeners).`);
  } catch (error) {
    console.warn("Mihomo boot render skipped:", error instanceof Error ? error.message : error);
  }
  if (!existsSync(config.mihomoConfigPath)) {
    console.log(`Mihomo auto-boot skipped: no config at ${config.mihomoConfigPath}.`);
    return;
  }
  try {
    const current = await readMihomoStatus(config);
    if (current.running) {
      const reloaded = await reloadMihomo(config);
      console.log(`Mihomo already running (pid ${reloaded.pid ?? current.pid}); SIGHUP sent.`);
      return;
    }
    const started = await startMihomo(config);
    console.log(`Mihomo auto-started (pid ${started.pid}).`);
  } catch (error) {
    console.error("Mihomo auto-boot failed:", error instanceof Error ? error.message : error);
  }
}

async function writeGenerated(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function isAuthenticated(request: Request): Promise<boolean> {
  if (!repo.hasPassword()) {
    return false;
  }
  const token = parseCookie(request.headers.get("cookie") ?? "")[sessionCookieName];
  return token ? Boolean(repo.findSessionByTokenHash(hashSessionToken(token))) : false;
}

function createSession(c: Context): string {
  const token = createSessionToken();
  repo.createSession({
    id: randomUUID(),
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(Date.now() + sessionTtlSeconds * 1000).toISOString()
  });
  setCookie(c, sessionCookieName, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: process.env.HIVE_COOKIE_SECURE === "true",
    path: "/",
    maxAge: sessionTtlSeconds
  });
  return token;
}

function sanitizeDownloadFilename(value: string): string {
  const filename = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return filename.endsWith(".json") ? filename : `${filename}.json`;
}

function parseCookie(header: string): Record<string, string> {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index === -1 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}
