import { Buffer } from "node:buffer";
import { parse as parseYaml } from "yaml";
import type { ProxyNode } from "@mihomo-hive/schemas";
import { inferRegion } from "./region.js";
import { proxyIdentityHash } from "./proxy-identity.js";

type RawProxy = Record<string, unknown> & { name?: unknown; type?: unknown };

export function parseSubscription(content: string, sourceId: string): ProxyNode[] {
  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }

  const clashNodes = parseClashYaml(trimmed, sourceId);
  if (clashNodes.length > 0) {
    return clashNodes;
  }

  const decoded = decodeMaybeBase64(trimmed);
  const lines = decoded
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.flatMap((line, index) => {
    const raw = parseUriNode(line, index);
    return raw ? [toProxyNode(raw, sourceId)] : [];
  });
}

function parseClashYaml(content: string, sourceId: string): ProxyNode[] {
  try {
    const parsed = parseYaml(content) as { proxies?: unknown };
    if (!parsed || !Array.isArray(parsed.proxies)) {
      return [];
    }
    return parsed.proxies
      .filter((item): item is RawProxy => Boolean(item && typeof item === "object"))
      .filter((raw) => !isInformationalProxy(raw))
      .map((raw) => toProxyNode(raw, sourceId));
  } catch {
    return [];
  }
}

function isInformationalProxy(raw: RawProxy): boolean {
  const name = String(raw.name ?? "");
  const server = String(raw.server ?? "");
  const port = Number(raw.port);

  if (server === "127.0.0.1" && port === 65535) {
    return true;
  }

  return /剩余流量|套餐到期|距离下次重置|客户端|不支持|请更换|官网|订阅/i.test(name);
}

function decodeMaybeBase64(content: string): string {
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(content) && !content.includes("://")) {
    try {
      return Buffer.from(content.replace(/\s+/g, ""), "base64").toString("utf8");
    } catch {
      return content;
    }
  }
  return content;
}

function parseUriNode(uri: string, index: number): RawProxy | undefined {
  if (uri.startsWith("vmess://")) {
    return parseVmess(uri, index);
  }

  const protocol = uri.match(/^([a-z0-9+.-]+):\/\//i)?.[1]?.toLowerCase();
  if (!protocol) {
    return undefined;
  }

  const name = decodeURIComponent(uri.split("#")[1] ?? `${protocol}-${index + 1}`);
  return {
    name,
    type: protocol,
    uri
  };
}

function parseVmess(uri: string, index: number): RawProxy {
  try {
    const payload = uri.slice("vmess://".length);
    const decoded = Buffer.from(payload, "base64").toString("utf8");
    const data = JSON.parse(decoded) as Record<string, unknown>;
    return {
      name: String(data.ps ?? `vmess-${index + 1}`),
      type: "vmess",
      server: data.add,
      port: Number(data.port),
      uuid: data.id,
      alterId: Number(data.aid ?? 0),
      cipher: data.scy ?? "auto",
      tls: data.tls === "tls",
      network: data.net,
      rawVmess: data
    };
  } catch {
    return {
      name: `vmess-${index + 1}`,
      type: "vmess",
      uri
    };
  }
}

function toProxyNode(raw: RawProxy, sourceId: string): ProxyNode {
  const originalName = String(raw.name ?? "unnamed-node");
  const now = new Date().toISOString();
  // 订阅供应商经常会改节点展示名、排序或附加元数据；这些变化不应制造新节点。
  // 指纹只基于连接参数，跨刷新/改名保持稳定，避免节点池不断膨胀。
  const hash = proxyIdentityHash(raw);
  return {
    hash,
    sourceId,
    name: originalName,
    originalName,
    type: String(raw.type ?? "unknown"),
    region: inferRegion(originalName),
    raw,
    status: "untested",
    lifecycleStatus: "candidate",
    schedulable: false,
    protected: false,
    codexLoginSuccess: 0,
    codexLoginFailure: 0,
    codexReserved: false,
    createdAt: now,
    updatedAt: now
  };
}
