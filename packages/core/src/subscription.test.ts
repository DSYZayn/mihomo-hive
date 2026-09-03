import { describe, expect, it } from "vitest";
import { parseSubscription } from "./subscription.js";

describe("parseSubscription", () => {
  it("parses Clash YAML proxies", () => {
    const nodes = parseSubscription(
      `
proxies:
  - name: JP-1
    type: ss
    server: example.com
    port: 443
`,
      "source-1"
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.name).toBe("JP-1");
    expect(nodes[0]?.region).toBe("jp");
  });

  it("skips subscription info and unsupported-client placeholder proxies", () => {
    const nodes = parseSubscription(
      `
proxies:
  - name: 剩余流量：97.03 GB
    type: vless
    server: example.com
    port: 443
  - name: 当前Clash客户端不支持本机场协议
    type: ss
    server: 127.0.0.1
    port: 65535
  - name: JP-Real
    type: vless
    server: jp.example.com
    port: 443
`,
      "source-1"
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.name).toBe("JP-Real");
  });

  it("keeps a stable fingerprint when the provider only renames a node", () => {
    const first = parseSubscription(
      `proxies:\n  - name: JP-1\n    type: ss\n    server: example.com\n    port: 443\n`,
      "source-1"
    );
    const renamed = parseSubscription(
      `proxies:\n  - name: JP-1 Premium\n    type: ss\n    server: example.com\n    port: 443\n`,
      "source-1"
    );

    expect(renamed[0]?.hash).toBe(first[0]?.hash);
  });

  it("normalizes URI fragments and query ordering for refresh deduplication", () => {
    const first = parseSubscription("ss://user:pass@EXAMPLE.com:443?b=2&a=1&sub=primary#JP-1", "source-1");
    const refreshed = parseSubscription("ss://user:pass@example.com:443?a=1&b=2&sub=backup#JP-1-renamed", "source-1");
    expect(refreshed[0]?.hash).toBe(first[0]?.hash);
  });

  it("keeps a stable fingerprint when provider metadata changes", () => {
    const first = parseSubscription(
      `proxies:\n  - name: JP-1\n    type: trojan\n    server: EXAMPLE.com\n    port: "443"\n    password: secret\n    sni: EDGE.example.com\n    provider: primary\n    description: old\n`,
      "source-1"
    );
    const refreshed = parseSubscription(
      `proxies:\n  - name: JP-1 Premium\n    type: TROJAN\n    server: example.com\n    port: 443\n    password: secret\n    sni: edge.example.com\n    provider: backup\n    description: new\n`,
      "source-1"
    );

    expect(refreshed[0]?.hash).toBe(first[0]?.hash);
  });

  it("uses the same identity for URI and equivalent Clash YAML nodes", () => {
    const fromUri = parseSubscription("ss://YWVzLTI1Ni1nY206cGFzcw==@EXAMPLE.com:443#JP-1", "source-1")[0];
    const fromYaml = parseSubscription(
      `proxies:
  - name: JP-1 Premium
    type: ss
    server: example.com
    port: 443
    cipher: aes-256-gcm
    password: pass
`,
      "source-1"
    )[0];

    expect(fromUri?.hash).toBe(fromYaml?.hash);
    expect(fromUri?.raw).not.toHaveProperty("uri");
    expect(fromUri?.raw).toMatchObject({ type: "ss", server: "EXAMPLE.com", port: 443, cipher: "aes-256-gcm", password: "pass" });
  });

  it("applies protocol defaults so a trojan URI matches YAML without explicit tls", () => {
    const fromUri = parseSubscription("trojan://secret@example.com:443?sni=edge.example.com#US-1", "source-1")[0];
    const fromYaml = parseSubscription(
      `proxies:
  - name: US-1
    type: trojan
    server: example.com
    port: 443
    password: secret
    sni: edge.example.com
`,
      "source-1"
    )[0];

    expect(fromUri?.hash).toBe(fromYaml?.hash);
  });

  it("decodes URL-safe base64 subscription bodies", () => {
    const body = "trojan://secret@example.com:443#US-1\n";
    const encoded = Buffer.from(body, "utf8").toString("base64url");
    const nodes = parseSubscription(encoded, "source-1");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.raw).toMatchObject({ type: "trojan", server: "example.com", port: 443, password: "secret" });
  });

  it("expands the common full-base64 Shadowsocks URI form", () => {
    const encoded = Buffer.from("aes-256-gcm:pass@example.com:443", "utf8").toString("base64url");
    const fromUri = parseSubscription(`ss://${encoded}#US-1`, "source-1")[0];
    const fromYaml = parseSubscription(
      `proxies:
  - name: US-1
    type: ss
    server: example.com
    port: 443
    cipher: aes-256-gcm
    password: pass
`,
      "source-1"
    )[0];

    expect(fromUri?.raw).toMatchObject({ type: "ss", server: "example.com", port: 443, cipher: "aes-256-gcm", password: "pass" });
    expect(fromUri?.raw).not.toHaveProperty("uri");
    expect(fromUri?.hash).toBe(fromYaml?.hash);
  });

  it("accepts full-base64 Shadowsocks URIs with the optional plugin query", () => {
    const encoded = Buffer.from("aes-256-gcm:pass@example.com:443", "utf8").toString("base64url");
    const node = parseSubscription(`ss://${encoded}/?plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3Dedge.example.com#US-1`, "source-1")[0];

    expect(node?.raw).toMatchObject({
      plugin: "obfs-local",
      "plugin-opts": { obfs: "http", "obfs-host": "edge.example.com" }
    });
  });

  it("keeps VLESS transport and Reality parameters stable across URI and YAML", () => {
    const fromUri = parseSubscription(
      "vless://uuid@example.com:443?encryption=none&security=reality&sni=edge.example.com&type=ws&path=%2Fchat&host=edge.example.com&pbk=public-key&sid=short-id&fp=chrome#US-1",
      "source-1"
    )[0];
    const fromYaml = parseSubscription(
      `proxies:
  - name: US-1
    type: vless
    server: example.com
    port: 443
    uuid: uuid
    encryption: none
    tls: true
    sni: edge.example.com
    network: ws
    ws-opts:
      path: /chat
      headers:
        Host: edge.example.com
    reality-opts:
      public-key: public-key
      short-id: short-id
    client-fingerprint: chrome
`,
      "source-1"
    )[0];

    expect(fromUri?.hash).toBe(fromYaml?.hash);
  });

  it("does not create a second VMess identity when optional fields are omitted in YAML", () => {
    const vmessPayload = Buffer.from(
      JSON.stringify({ v: "2", ps: "US-1", add: "example.com", port: 443, id: "uuid", aid: 0, scy: "auto", net: "tcp", tls: "" }),
      "utf8"
    ).toString("base64");
    const fromUri = parseSubscription(`vmess://${vmessPayload}`, "source-1")[0];
    const fromYaml = parseSubscription(
      `proxies:
  - name: US-1
    type: vmess
    server: example.com
    port: 443
    uuid: uuid
`,
      "source-1"
    )[0];

    expect(fromUri?.hash).toBe(fromYaml?.hash);
  });

  it("normalizes SSR URI credentials to the same identity as Clash YAML", () => {
    const password = Buffer.from("secret", "utf8").toString("base64");
    const payload = Buffer.from(`example.com:443:origin:aes-128-gcm:plain:${password}/?`, "utf8").toString("base64url");
    const fromUri = parseSubscription(`ssr://${payload}#SG-1`, "source-1")[0];
    const fromYaml = parseSubscription(
      `proxies:
  - name: SG-1
    type: ssr
    server: example.com
    port: 443
    protocol: origin
    cipher: aes-128-gcm
    obfs: plain
    password: secret
`,
      "source-1"
    )[0];

    expect(fromUri?.hash).toBe(fromYaml?.hash);
  });

  it("distinguishes credentials and transport paths", () => {
    const first = parseSubscription(
      `proxies:\n  - name: US-1\n    type: vless\n    server: example.com\n    port: 443\n    uuid: user-1\n    network: ws\n    ws-opts:\n      path: /primary\n`,
      "source-1"
    );
    const changed = parseSubscription(
      `proxies:\n  - name: US-1\n    type: vless\n    server: example.com\n    port: 443\n    uuid: user-2\n    network: ws\n    ws-opts:\n      path: /secondary\n`,
      "source-1"
    );

    expect(changed[0]?.hash).not.toBe(first[0]?.hash);
  });
});
