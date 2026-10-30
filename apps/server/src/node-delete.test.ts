import { afterEach, describe, expect, it, vi } from "vitest";
import { HiveRepository, openSqlite, type HiveSqlite } from "@mihomo-hive/db";
import { proxyNodeSchema, runtimeConfigSchema, type ProxyNode } from "@mihomo-hive/schemas";
import { appRouter } from "./router.js";

describe("nodes.delete", () => {
  let sqlite: HiveSqlite | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    sqlite?.close();
    sqlite = undefined;
  });

  it("keeps local deletion available when the Sub2API admin key is invalid", async () => {
    sqlite = openSqlite(":memory:");
    const repo = new HiveRepository(sqlite);
    repo.setSub2ApiConnection({
      baseUrl: "https://sub2api.example.com",
      adminApiKey: "expired-key",
      timezone: "Asia/Shanghai",
      managedProxyPrefix: "MH-"
    });
    const node = proxyNodeSchema.parse({
      hash: "node0001abcdef",
      sourceId: "test",
      name: "node",
      originalName: "node",
      type: "http",
      region: "unknown",
      raw: { type: "http", server: "proxy.example.com", port: 443 },
      assignedPort: 10001,
      lifecycleStatus: "candidate",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }) as ProxyNode;
    repo.upsertNodes([node]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ code: 401, message: "invalid admin key" }), {
          status: 401,
          headers: { "content-type": "application/json" }
        })
      )
    );

    const caller = appRouter.createCaller({ repo, config: runtimeConfigSchema.parse({}), authenticated: true });
    const preview = await caller.nodes.previewDelete({ hashes: [node.hash] });
    expect(preview.canDeleteNow).toBe(true);
    expect(preview.blockingAccounts).toEqual([]);
    expect(preview.remoteStatus).toBe("unavailable");
    expect(preview.message).toContain("Sub2API 当前不可访问");

    const result = await caller.nodes.applyDelete({ hashes: [node.hash] });
    expect(result.deleted).toBe(1);
    expect(result.sub2apiCleanupError).toContain("HTTP 401");
    expect(result.plan.remoteStatus).toBe("unavailable");
    expect(repo.listNodes()).toEqual([]);
  });
});
