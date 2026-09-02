import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProxyNode } from "@mihomo-hive/schemas";
import { openSqlite, type HiveSqlite } from "./client.js";
import { HiveRepository } from "./repository.js";

describe("HiveRepository node identity deduplication", () => {
  let tmpDir: string;
  let sqlite: HiveSqlite;
  let repo: HiveRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hive-node-dedup-"));
    sqlite = openSqlite(join(tmpDir, "hive.sqlite"));
    repo = new HiveRepository(sqlite);
  });

  afterEach(() => {
    sqlite.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("merges legacy rows that differ only by provider metadata", () => {
    repo.upsertNodes([
      node("legacy001", "SG-1", { provider: "primary" }, 10001),
      node("legacy002", "SG-1 Premium", { provider: "backup" })
    ]);

    expect(repo.deduplicateNodesByIdentity()).toBe(1);
    const nodes = repo.listNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.assignedPort).toBe(10001);
  });
});

function node(hash: string, name: string, options: Record<string, unknown>, assignedPort?: number): ProxyNode {
  const now = "2026-09-02T00:00:00.000Z";
  return {
    hash,
    sourceId: "source-1",
    name,
    originalName: name,
    type: "trojan",
    region: "sg",
    raw: {
      name,
      type: "trojan",
      server: "sg.example.com",
      port: 443,
      password: "secret",
      ...options
    },
    status: "untested",
    lifecycleStatus: "candidate",
    schedulable: false,
    protected: false,
    ...(assignedPort ? { assignedPort } : {}),
    codexLoginSuccess: 0,
    codexLoginFailure: 0,
    codexReserved: false,
    createdAt: now,
    updatedAt: now
  };
}
