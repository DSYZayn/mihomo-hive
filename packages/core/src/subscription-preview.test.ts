import { describe, expect, it } from "vitest";
import { parseSubscription } from "./subscription.js";
import { buildSubscriptionImportPreview, filteredExistingNodeHashes, filterPreviewImportableNodes } from "./subscription-preview.js";

describe("buildSubscriptionImportPreview", () => {
  it("classifies importable, filtered, duplicate and existing nodes before import", () => {
    const content = `
proxies:
  - name: JP-1
    type: ss
    server: jp.example.com
    port: 443
  - name: JP-1
    type: ss
    server: jp.example.com
    port: 443
  - name: BadNode
    type: ss
    server: info.example.com
    port: 443
  - name: US-Existing
    type: vless
    server: us.example.com
    port: 443
`;
    const parsed = parseSubscription(content, "other-source");
    const existing = [{ ...parsed[3]!, sourceId: "other-source", lifecycleStatus: "schedulable" as const, schedulable: true }];

    const preview = buildSubscriptionImportPreview({
      source: { id: "source-1", name: "primary", kind: "url", value: "https://example.com/sub" },
      content,
      existingNodes: existing,
      excludeKeywords: ["BadNode"]
    });

    expect(preview.summary).toMatchObject({
      total: 4,
      importable: 1,
      duplicates: 1,
      existing: 1,
      filtered: 1
    });
    expect(preview.items.map((item) => item.action)).toEqual(["import", "skip_duplicate", "skip_filtered", "skip_existing"]);
    expect(filterPreviewImportableNodes({
      source: { id: "source-1", name: "primary", kind: "url", value: "https://example.com/sub" },
      content,
      existingNodes: existing,
      excludeKeywords: ["BadNode"]
    })).toHaveLength(1);
  });

  it("marks filtered existing nodes for deletion during re-import", () => {
    const content = `
proxies:
  - name: Hong Kong 01
    type: vless
    server: hk.example.com
    port: 443
`;
    const existing = parseSubscription(content, "source-1").map((node) => ({
      ...node,
      lifecycleStatus: "schedulable" as const,
      schedulable: true
    }));
    const preview = buildSubscriptionImportPreview({
      source: { id: "source-1", name: "primary", kind: "url", value: "https://example.com/sub" },
      content,
      existingNodes: existing,
      excludeKeywords: ["Hong Kong"]
    });

    expect(preview.summary.deletedByFilter).toBe(1);
    expect(filteredExistingNodeHashes({
      source: { id: "source-1", name: "primary", kind: "url", value: "https://example.com/sub" },
      content,
      existingNodes: existing,
      excludeKeywords: ["Hong Kong"]
    })).toEqual([existing[0]?.hash]);
  });

  it("updates an existing node when only provider metadata changed", () => {
    const existing = parseSubscription(
      `proxies:\n  - name: SG-1\n    type: trojan\n    server: sg.example.com\n    port: 443\n    password: secret\n    provider: primary\n`,
      "source-1"
    );
    const content = `proxies:\n  - name: SG-1 Premium\n    type: trojan\n    server: sg.example.com\n    port: 443\n    password: secret\n    provider: backup\n`;
    const input = {
      source: { id: "source-1", name: "primary", kind: "url" as const, value: "https://example.com/sub" },
      content,
      existingNodes: existing
    };
    const preview = buildSubscriptionImportPreview(input);

    expect(preview.items).toHaveLength(1);
    expect(preview.items[0]?.action).toBe("update");
    expect(filterPreviewImportableNodes(input)[0]?.hash).toBe(existing[0]?.hash);
  });

  it("matches legacy URI-only rows before the repository repair pass", () => {
    const parsed = parseSubscription("trojan://secret@sg.example.com:443?sni=edge.example.com#SG-1", "source-1")[0]!;
    const existing = [
      {
        ...parsed,
        hash: "legacy-uri-hash",
        raw: { name: "old", type: "trojan", uri: "trojan://secret@SG.EXAMPLE.com:443?sni=edge.example.com#old" }
      }
    ];
    const input = {
      source: { id: "source-1", name: "primary", kind: "url" as const, value: "https://example.com/sub" },
      content: "trojan://secret@sg.example.com:443?sni=edge.example.com#SG-1",
      existingNodes: existing
    } as const;
    const preview = buildSubscriptionImportPreview(input);

    expect(preview.items[0]?.action).toBe("update");
    expect(filterPreviewImportableNodes(input)[0]?.hash).toBe("legacy-uri-hash");
  });

  it("matches legacy Shadowsocks plugin URIs during an automatic refresh", () => {
    const uri = "ss://YWVzLTI1Ni1nY206c2VjcmV0@sg.example.com:443?plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3Dedge.example.com#SG-1";
    const parsed = parseSubscription(uri, "source-1")[0]!;
    const input = {
      source: { id: "source-1", name: "primary", kind: "url" as const, value: "https://example.com/sub" },
      content: uri,
      existingNodes: [
        {
          ...parsed,
          hash: "legacy-ss-plugin-hash",
          raw: { name: "old", type: "ss", uri: uri.replace("#SG-1", "#old") }
        }
      ]
    };

    expect(buildSubscriptionImportPreview(input).items[0]?.action).toBe("update");
    expect(filterPreviewImportableNodes(input)[0]?.hash).toBe("legacy-ss-plugin-hash");
  });

  it.each([
    [
      "Trojan transport options",
      "trojan://secret@example.com:443?sni=edge.example.com&allow-insecure=1&alpn=h2,http/1.1&type=ws&path=%2Fws&host=edge.example.com#old"
    ],
    [
      "VLESS gRPC options",
      "vless://uuid@example.com:443?encryption=none&security=tls&sni=edge.example.com&type=grpc&serviceName=svc#old"
    ],
    [
      "Hysteria2 credentials",
      "hysteria2://secret@example.com:443?sni=edge.example.com&insecure=1&obfs=salamander&obfs-password=obfs-secret#old"
    ],
    [
      "TUIC credentials",
      "tuic://uuid:secret@example.com:443?sni=edge.example.com&congestion_control=bbr&udp_relay_mode=native&zero_rtt=true#old"
    ],
    [
      "SSR fragments",
      `ssr://${Buffer.from(`example.com:443:origin:aes-128-gcm:plain:${Buffer.from("secret").toString("base64url")}/?`).toString("base64url")}#old`
    ]
  ])("matches legacy %s URI rows with the current expanded parser", (_, uri) => {
    const parsed = parseSubscription(uri, "source-1")[0]!;
    const input = {
      source: { id: "source-1", name: "primary", kind: "url" as const, value: "https://example.com/sub" },
      content: uri,
      existingNodes: [
        {
          ...parsed,
          hash: "legacy-expanded-uri-hash",
          raw: { name: "old", type: uri.slice(0, uri.indexOf(":")), uri }
        }
      ]
    };

    expect(buildSubscriptionImportPreview(input).items[0]?.action).toBe("update");
    expect(filterPreviewImportableNodes(input)[0]?.hash).toBe("legacy-expanded-uri-hash");
  });

  it("returns the legacy row hash for filtered deletion", () => {
    const parsed = parseSubscription("trojan://secret@sg.example.com:443#SG-1", "source-1")[0]!;
    const existing = [
      {
        ...parsed,
        hash: "legacy-filter-hash",
        raw: { name: "old", type: "trojan", uri: "trojan://secret@SG.EXAMPLE.com:443#old" }
      }
    ];
    const input = {
      source: { id: "source-1", name: "primary", kind: "url" as const, value: "https://example.com/sub" },
      content: "trojan://secret@sg.example.com:443#SG-1",
      existingNodes: existing,
      excludeKeywords: ["SG"]
    };

    expect(filteredExistingNodeHashes(input)).toEqual(["legacy-filter-hash"]);
  });

  it("matches pre-normalization VMess rows during an automatic refresh", () => {
    const vmessData = {
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
    };
    const refreshed = parseSubscription(`vmess://${Buffer.from(JSON.stringify(vmessData)).toString("base64")}`, "source-1")[0]!;
    const existing = [
      {
        ...refreshed,
        hash: "legacy-vmess-hash",
        raw: {
          name: vmessData.ps,
          type: "vmess",
          server: vmessData.add,
          port: vmessData.port,
          uuid: vmessData.id,
          alterId: vmessData.aid,
          cipher: vmessData.scy,
          tls: true,
          network: vmessData.net,
          rawVmess: vmessData
        }
      }
    ];
    const input = {
      source: { id: "source-1", name: "primary", kind: "url" as const, value: "https://example.com/sub" },
      content: `vmess://${Buffer.from(JSON.stringify({ ...vmessData, ps: "JP 免费-日本3-Ver.7" })).toString("base64")}`,
      existingNodes: existing
    } as const;

    const preview = buildSubscriptionImportPreview(input);

    expect(preview.items[0]?.action).toBe("update");
    expect(filterPreviewImportableNodes(input)[0]?.hash).toBe("legacy-vmess-hash");
  });
});
