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
    const first = node("legacy001", "SG-1", { provider: "primary" }, 10001);
    repo.upsertNodes([first]);
    cloneLegacyRow(sqlite, first.hash, "legacy002", {
      ...first.raw,
      name: "SG-1 Premium",
      provider: "backup"
    }, "SG-1 Premium");

    expect(repo.deduplicateNodesByIdentity()).toBe(1);
    const nodes = repo.listNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.assignedPort).toBe(10001);
  });

  it("merges a legacy URI-only row with the expanded Mihomo endpoint", () => {
    const first = node("legacy-uri", "SG-1", { uri: "trojan://secret@SG.EXAMPLE.com:443?sni=edge.example.com#old" }, 10001);
    repo.upsertNodes([first]);
    cloneLegacyRow(sqlite, first.hash, "expanded", {
      name: "SG-1 Premium",
      type: "trojan",
      server: "sg.example.com",
      port: 443,
      password: "secret",
      sni: "edge.example.com"
    }, "SG-1 Premium");

    expect(repo.deduplicateNodesByIdentity()).toBe(1);
    const nodes = repo.listNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.assignedPort).toBe(10001);
  });

  it("merges a full-base64 Shadowsocks URI row with its expanded endpoint", () => {
    const uri = `ss://${Buffer.from("aes-256-gcm:secret@sg.example.com:443", "utf8").toString("base64url")}#old`;
    const first = node("legacy-full-ss", "SG-1", { type: "ss", uri }, 10001);
    repo.upsertNodes([first]);
    cloneLegacyRow(sqlite, first.hash, "expanded-full-ss", {
      name: "SG-1 Premium",
      type: "ss",
      server: "sg.example.com",
      port: 443,
      cipher: "aes-256-gcm",
      password: "secret"
    }, "SG-1 Premium");

    expect(repo.deduplicateNodesByIdentity()).toBe(1);
    expect(repo.listNodes()).toHaveLength(1);
  });

  it("merges a legacy Shadowsocks plugin URI with its expanded endpoint", () => {
    const uri = "ss://YWVzLTI1Ni1nY206c2VjcmV0@sg.example.com:443?plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3Dedge.example.com#old";
    const first = node("legacy-ss-plugin", "SG-1", { type: "ss", uri }, 10001);
    repo.upsertNodes([first]);
    cloneLegacyRow(sqlite, first.hash, "expanded-ss-plugin", {
      name: "SG-1 Premium",
      type: "ss",
      server: "sg.example.com",
      port: 443,
      cipher: "aes-256-gcm",
      password: "secret",
      plugin: "obfs-local",
      "plugin-opts": { obfs: "http", "obfs-host": "edge.example.com" }
    }, "SG-1 Premium");

    expect(repo.deduplicateNodesByIdentity()).toBe(1);
    expect(repo.listNodes()).toHaveLength(1);
    expect(repo.listNodes()[0]?.assignedPort).toBe(10001);
  });

  it("merges a pre-normalization VMess row with its expanded endpoint", () => {
    const legacyRaw = {
      name: "JP 免费-日本3-Ver.7",
      type: "vmess",
      server: "jp.example.com",
      port: 443,
      uuid: "vmess-user",
      alterId: 0,
      cipher: "auto",
      tls: true,
      network: "ws",
      rawVmess: {
        v: "2",
        ps: "JP 免费-日本3-Ver.7",
        add: "jp.example.com",
        port: 443,
        id: "vmess-user",
        aid: 0,
        scy: "auto",
        net: "ws",
        tls: "tls",
        host: "edge.example.com",
        path: "/chat"
      },
      "ws-opts": { path: "/chat", headers: { Host: "edge.example.com" } }
    };
    const expandedRaw = {
      name: "JP 免费-日本3-Ver.7",
      type: "vmess",
      server: "jp.example.com",
      port: 443,
      uuid: "vmess-user",
      alterId: 0,
      cipher: "auto",
      tls: true,
      network: "ws",
      "ws-opts": { path: "/chat", headers: { Host: "edge.example.com" } }
    };
    const first = node("legacy-vmess-hash", "JP 免费-日本3-Ver.7", { ...legacyRaw, password: undefined }, 10001);
    repo.upsertNodes([first]);
    cloneLegacyRow(sqlite, first.hash, "expanded-vmess-hash", expandedRaw, "JP 免费-日本3-Ver.7");

    expect(repo.deduplicateNodesByIdentity()).toBe(1);
    expect(repo.listNodes()).toHaveLength(1);
    expect(repo.listNodes()[0]?.assignedPort).toBe(10001);
  });

  it("reuses an existing row when a refresh gives the same endpoint a new hash", () => {
    repo.upsertNodes([node("first-hash", "SG-1", {}, 10001)]);
    repo.upsertNodes([node("fresh-hash", "SG-1 renamed", {}, undefined)]);

    const nodes = repo.listNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.hash).toBe("first-hash");
    expect(nodes[0]?.assignedPort).toBe(10001);
    expect(nodes[0]?.name).toBe("SG-1 renamed");
  });

  it("merges rows when legacy optional fields are omitted or explicitly undefined", () => {
    const first = node("legacy-optional", "SG-1", { "ws-opts": { path: "/chat", headers: { Host: "EDGE.EXAMPLE.COM" } } }, 10001);
    repo.upsertNodes([first]);
    cloneLegacyRow(
      sqlite,
      first.hash,
      "legacy-optional-copy",
      {
        ...first.raw,
        "ws-opts": {
          path: "/chat",
          headers: { Host: "edge.example.com" },
          "max-early-data": undefined
        }
      },
      "SG-1 renamed"
    );

    expect(repo.deduplicateNodesByIdentity()).toBe(1);
    expect(repo.listNodes()).toHaveLength(1);
  });

  it("merges same-name unassigned candidates from the same source", () => {
    repo.upsertNodes([
      node("name-copy-a", "HK 香港A03 | IEPL", { server: "sg-a.example.com" }),
      node("name-copy-b", " hk  香港a03 | iepl ", { server: "sg-b.example.com" })
    ]);

    expect(repo.listNodes()).toHaveLength(2);
    expect(repo.deduplicateNodesByIdentity()).toBe(1);
    expect(repo.listNodes()).toHaveLength(1);
  });

  it("does not merge same-name nodes after a port is assigned", () => {
    repo.upsertNodes([
      node("name-live-a", "HK 香港A03 | IEPL", { server: "sg-a.example.com" }, 10001),
      node("name-live-b", "HK 香港A03 | IEPL", { server: "sg-b.example.com" }, 10002)
    ]);

    expect(repo.deduplicateNodesByIdentity()).toBe(0);
    expect(repo.listNodes()).toHaveLength(2);
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

function cloneLegacyRow(
  sqlite: HiveSqlite,
  sourceHash: string,
  cloneHash: string,
  raw: Record<string, unknown>,
  name: string
): void {
  const row = sqlite.prepare("SELECT * FROM nodes WHERE hash = ?").get(sourceHash) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`missing source row ${sourceHash}`);
  row.hash = cloneHash;
  row.name = name;
  row.original_name = name;
  row.raw_json = JSON.stringify(raw);
  const columns = Object.keys(row);
  sqlite
    .prepare(`INSERT INTO nodes (${columns.join(", ")}) VALUES (${columns.map((column) => `@${column}`).join(", ")})`)
    .run(row);
}
