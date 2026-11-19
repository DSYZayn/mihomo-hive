import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSubscription } from "@mihomo-hive/core";
import { openSqlite } from "./client.js";
import { HiveRepository } from "./repository.js";

describe("subscription proxy persistence", () => {
  it("migrates an existing database without losing subscriptions or cached content", () => {
    const directory = mkdtempSync(join(tmpdir(), "hive-subscription-proxy-"));
    const path = join(directory, "state.db");
    let sqlite = openSqlite(path);
    try {
      const repo = new HiveRepository(sqlite);
      repo.addSubscription({ id: "existing", name: "existing", kind: "url", value: "https://example.com/sub" });
      repo.updateSubscriptionContent("existing", "cached subscription");
      sqlite.exec("ALTER TABLE subscriptions DROP COLUMN fetch_proxy_node_hash");
      sqlite.close();
      sqlite = openSqlite(path);
      expect(new HiveRepository(sqlite).listSubscriptions()[0]).toMatchObject({
        id: "existing", fetchProxyNodeHash: null, lastContent: "cached subscription"
      });
    } finally {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retains the selected node when legacy node hashes are normalized", () => {
    const sqlite = openSqlite(":memory:");
    try {
      const repo = new HiveRepository(sqlite);
      const node = parseSubscription("proxies:\n  - name: Proxy\n    type: socks5\n    server: proxy.example.com\n    port: 1080\n", "seed")[0]!;
      repo.upsertNodes([{ ...node, hash: "legacy-node-hash", assignedPort: 10001 }]);
      repo.addSubscription({ id: "proxied", name: "proxied", kind: "url", value: "https://example.com/sub", fetchProxyNodeHash: "legacy-node-hash" });
      repo.deduplicateNodesByIdentity();
      expect(repo.listSubscriptions()[0]?.fetchProxyNodeHash).toBe(node.hash);
      repo.addSubscription({ id: "proxied", name: "renamed", kind: "url", value: "https://example.com/sub" });
      expect(repo.listSubscriptions()[0]?.fetchProxyNodeHash).toBe(node.hash);
      repo.updateSubscriptionFetchProxy("proxied", null);
      expect(repo.listSubscriptions()[0]?.fetchProxyNodeHash).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});
