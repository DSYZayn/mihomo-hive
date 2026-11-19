import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { once } from "node:events";
import { parseSubscription } from "@mihomo-hive/core";
import { HiveRepository, openSqlite, type HiveSqlite } from "@mihomo-hive/db";
import { runtimeConfigSchema } from "@mihomo-hive/schemas";
import { appRouter } from "./router.js";

describe("subscription import failures", () => {
  let sqlite: HiveSqlite;
  let repo: HiveRepository;
  let server: Server;
  let url: string;
  let body: string;
  const proxies: net.Server[] = [];
  const proxySockets = new Set<net.Socket>();
  const valid = "proxies:\n  - name: US-test\n    type: socks5\n    server: example.com\n    port: 1080\n";

  beforeEach(async () => {
    vi.stubEnv("NO_PROXY", "127.0.0.1");
    vi.stubEnv("no_proxy", "127.0.0.1");
    sqlite = openSqlite(":memory:");
    repo = new HiveRepository(sqlite);
    body = "<html><body>Subscription expired</body></html>";
    server = createServer((_req, res) => res.end(body));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sub?token=private-token`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    sqlite.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of proxySockets) socket.destroy();
    await Promise.all(proxies.splice(0).map((proxy) => new Promise<void>((resolve) => proxy.close(() => resolve()))));
  });

  it("reports an HTML response as a named preview failure", async () => {
    const caller = appRouter.createCaller({ repo, config: runtimeConfigSchema.parse({}), authenticated: true });
    await expect(caller.subscriptions.previewImport({ name: "My subscription", url })).rejects.toThrow("订阅「My subscription」拉取失败：订阅返回了网页");
    expect(repo.listNodes()).toHaveLength(0);
  });

  it("preserves cached content and existing nodes when an import receives unusable content", async () => {
    const source = repo.addSubscription({ id: "existing", name: "existing", kind: "url", value: url });
    repo.updateSubscriptionContent(source.id, valid);
    repo.upsertNodes(parseSubscription(valid, source.id));
    const before = repo.listNodes();
    const caller = appRouter.createCaller({ repo, config: runtimeConfigSchema.parse({}), authenticated: true });
    await expect(caller.subscriptions.applyImport({ id: source.id, name: source.name, url, excludeKeywords: ["US"] })).rejects.toThrow("返回了网页");
    expect(repo.listSubscriptions()[0]?.lastContent).toBe(valid);
    expect(repo.listNodes()).toEqual(before);
  });

  it("still allows a valid preview with every node intentionally filtered", async () => {
    body = valid;
    const caller = appRouter.createCaller({ repo, config: runtimeConfigSchema.parse({}), authenticated: true });
    const preview = await caller.subscriptions.previewImport({ name: "valid", url, excludeKeywords: ["US"] });
    expect(preview.summary).toMatchObject({ total: 1, importable: 0, filtered: 1 });
  });

  async function startFetchProxy() {
    const destinations: string[] = [];
    const proxy = net.createServer((socket) => {
      proxySockets.add(socket);
      socket.on("close", () => proxySockets.delete(socket));
      let buffer = Buffer.alloc(0);
      let stage = 0;
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (stage === 0) {
          if (buffer.length < 2 + (buffer[1] ?? 0)) return;
          buffer = buffer.subarray(2 + buffer[1]!);
          socket.write(Buffer.from([5, 0]));
          stage = 1;
        }
        if (stage === 1) {
          if (buffer.length < 5) return;
          if (buffer[3] !== 3) { socket.destroy(); return; }
          const length = buffer[4]!;
          if (buffer.length < 7 + length) return;
          destinations.push(buffer.subarray(5, 5 + length).toString());
          buffer = buffer.subarray(7 + length);
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
          stage = 2;
        }
        if (stage === 2 && buffer.includes("\r\n\r\n")) {
          stage = 3;
          socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        }
      });
    });
    proxies.push(proxy);
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    return { port: (proxy.address() as AddressInfo).port, destinations };
  }

  it("uses and saves a selected node through preview, repreview, apply and subsequent refreshes", async () => {
    body = valid;
    const proxy = await startFetchProxy();
    const node = { ...parseSubscription(valid, "seed")[0]!, assignedPort: proxy.port };
    repo.upsertNodes([node]);
    repo = new HiveRepository(sqlite, { listenHost: "0.0.0.0" });
    const caller = appRouter.createCaller({ repo, config: runtimeConfigSchema.parse({}), authenticated: true });
    const input = { name: "proxied", url: "http://subscription.invalid/sub?token=private-token", fetchProxyNodeHash: node.hash };
    vi.stubEnv("NO_PROXY", "*");
    vi.stubEnv("no_proxy", "*");
    const preview = await caller.subscriptions.previewImport(input);
    expect(preview.source.fetchProxyNodeHash).toBe(node.hash);
    const repreview = await caller.subscriptions.previewImport({ ...input, id: preview.source.id! });
    expect(repreview.summary.total).toBe(1);
    const result = await caller.subscriptions.applyImport(input);
    const saved = repo.listSubscriptions().find((source) => source.id === result.sourceId)!;
    expect(saved.fetchProxyNodeHash).toBe(node.hash);
    expect(saved.lastContent).toBe(valid);
    await caller.subscriptions.fetch();
    expect(proxy.destinations).toEqual(Array(4).fill("subscription.invalid"));

    // Resolve the listener from current database state rather than persisting a port URL.
    const replacement = await startFetchProxy();
    repo.saveNodes([{ ...node, assignedPort: replacement.port }]);
    await repo.fetchSubscriptionContent(saved);
    expect(replacement.destinations).toEqual(["subscription.invalid"]);

    repo.markNodesLifecycle([node.hash], "retired");
    await expect(caller.subscriptions.fetch()).rejects.toThrow("退役或删除");
    expect(repo.listSubscriptions().find((source) => source.id === saved.id)?.lastContent).toBe(valid);
    await caller.subscriptions.updateFetchProxy({ id: saved.id, fetchProxyNodeHash: null });
    expect(repo.listSubscriptions().find((source) => source.id === saved.id)?.fetchProxyNodeHash).toBeNull();
  });

  it("allows an existing subscription to select a node before the first successful fetch", async () => {
    body = valid;
    const proxy = await startFetchProxy();
    const node = { ...parseSubscription(valid, "seed")[0]!, assignedPort: proxy.port };
    repo.upsertNodes([node]);
    const caller = appRouter.createCaller({ repo, config: runtimeConfigSchema.parse({}), authenticated: true });
    const source = await caller.subscriptions.add({ name: "saved", url: "http://subscription.invalid/sub" });
    await caller.subscriptions.updateFetchProxy({ id: source.id, fetchProxyNodeHash: node.hash });
    const preview = await caller.subscriptions.previewImport({ id: source.id });
    expect(preview.source.fetchProxyNodeHash).toBe(node.hash);
    expect(proxy.destinations).toEqual(["subscription.invalid"]);
    await expect(caller.subscriptions.updateFetchProxy({ id: source.id, fetchProxyNodeHash: "missing-node" })).rejects.toThrow("已不存在");
    expect(repo.listSubscriptions().find((item) => item.id === source.id)?.fetchProxyNodeHash).toBe(node.hash);
    const created = await caller.subscriptions.add({ name: "selected-on-save", url: "http://subscription.invalid/sub", fetchProxyNodeHash: node.hash });
    expect(created.fetchProxyNodeHash).toBe(node.hash);
    expect(proxy.destinations).toHaveLength(1);
  });
});
