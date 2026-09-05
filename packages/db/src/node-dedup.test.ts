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

  it("merges a legacy URI-only row with the expanded Mihomo endpoint", () => {
    repo.upsertNodes([
      node("legacy-uri", "SG-1", { uri: "trojan://secret@SG.EXAMPLE.com:443?sni=edge.example.com#old" }, 10001),
      node("expanded", "SG-1 Premium", { server: "sg.example.com", port: 443, sni: "edge.example.com" })
    ]);

    expect(repo.deduplicateNodesByIdentity()).toBe(1);
    const nodes = repo.listNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.assignedPort).toBe(10001);
  });

  it("merges a full-base64 Shadowsocks URI row with its expanded endpoint", () => {
    const uri = `ss://${Buffer.from("aes-256-gcm:secret@sg.example.com:443", "utf8").toString("base64url")}#old`;
    repo.upsertNodes([
      node("legacy-full-ss", "SG-1", { type: "ss", uri }, 10001),
      node("expanded-full-ss", "SG-1 Premium", { type: "ss", server: "sg.example.com", port: 443, cipher: "aes-256-gcm", password: "secret" })
    ]);

    expect(repo.deduplicateNodesByIdentity()).toBe(1);
    expect(repo.listNodes()).toHaveLength(1);
  });

  it("merges a legacy Shadowsocks plugin URI with its expanded endpoint", () => {
    const uri = "ss://YWVzLTI1Ni1nY206c2VjcmV0@sg.example.com:443?plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3Dedge.example.com#old";
    repo.upsertNodes([
      node("legacy-ss-plugin", "SG-1", { type: "ss", uri }, 10001),
      node("expanded-ss-plugin", "SG-1 Premium", {
        type: "ss",
        cipher: "aes-256-gcm",
        plugin: "obfs-local",
        "plugin-opts": { obfs: "http", "obfs-host": "edge.example.com" }
      })
    ]);

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
    repo.upsertNodes([
      node("legacy-vmess-hash", "JP 免费-日本3-Ver.7", { ...legacyRaw, password: undefined }, 10001),
      node("expanded-vmess-hash", "JP 免费-日本3-Ver.7", { ...expandedRaw, password: undefined })
    ]);

    expect(repo.deduplicateNodesByIdentity()).toBe(1);
    expect(repo.listNodes()).toHaveLength(1);
    expect(repo.listNodes()[0]?.assignedPort).toBe(10001);
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
