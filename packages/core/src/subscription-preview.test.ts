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
});
