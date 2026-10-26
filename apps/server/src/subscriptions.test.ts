import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
});
