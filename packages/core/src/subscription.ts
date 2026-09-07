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
  if (/^[A-Za-z0-9+/_=\-\r\n]+$/.test(content) && !content.includes("://")) {
    try {
      const decoded = tryDecodeBase64(content);
      return decoded.includes("://") || /^\s*(?:proxies|proxy-groups):/m.test(decoded) ? decoded : content;
    } catch {
      return content;
    }
  }
  return content;
}

function parseUriNode(uri: string, index: number): RawProxy | undefined {
  const protocol = uri.match(/^([a-z0-9+.-]+):\/\//i)?.[1]?.toLowerCase();
  if (!protocol) return undefined;
  const name = decodeUriName(uri, `${protocol}-${index + 1}`);
  const parsed = parseProxyUri(uri, name, index);
  return parsed ?? { name, type: protocol, uri };
}

/** Expand a subscription URI into a Mihomo `proxies` record. */
export function parseProxyUri(uri: string, name = "proxy", index = 0): RawProxy | undefined {
  const protocol = uri.match(/^([a-z0-9+.-]+):\/\//i)?.[1]?.toLowerCase();
  if (!protocol) return undefined;
  if (protocol === "vmess") return parseVmess(uri, index);
  if (protocol === "ss") {
    const decoded = parseFullBase64Shadowsocks(uri, name);
    if (decoded) return decoded;
  }
  return parseUriUrl(uri, protocol, name);
}

function parseVmess(uri: string, index: number): RawProxy {
  try {
    const payload = uri.slice("vmess://".length);
    const decoded = Buffer.from(payload, "base64").toString("utf8");
    const data = JSON.parse(decoded) as Record<string, unknown>;
    const server = typeof data.add === "string" ? data.add : "";
    const port = Number(data.port);
    const uuid = typeof data.id === "string" ? data.id : "";
    if (!server || !Number.isInteger(port) || port <= 0 || !uuid) throw new Error("invalid vmess endpoint");
    const wsOpts =
      data.host || data.path
        ? {
            ...(data.path ? { path: data.path } : {}),
            ...(data.host ? { headers: { Host: data.host } } : {})
          }
        : undefined;
    const raw: RawProxy = {
      name: String(data.ps ?? `vmess-${index + 1}`),
      type: "vmess",
      server,
      port,
      uuid,
      alterId: Number(data.aid ?? 0),
      cipher: data.scy ?? "auto",
      tls: data.tls === "tls"
    };
    if (typeof data.net === "string" && data.net) raw.network = data.net;
    if (wsOpts) raw["ws-opts"] = wsOpts;
    return raw;
  } catch {
    return {
      name: `vmess-${index + 1}`,
      type: "vmess",
      uri
    };
  }
}

function parseUriUrl(uri: string, protocol: string, name: string): RawProxy | undefined {
  if (protocol === "ssr") return parseSsr(uri, name);
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return undefined;
  }

  const type = protocol === "socks" ? "socks5" : protocol;
  const raw: RawProxy = { name, type, server: parsed.hostname };
  if (parsed.port) raw.port = Number(parsed.port);

  const username = safeDecode(parsed.username);
  const password = safeDecode(parsed.password);
  if (type === "ss") {
    parseShadowsocksCredentials(raw, username, password);
    parseShadowsocksPlugin(raw, parsed.searchParams.get("plugin"));
  } else if (type === "trojan") {
    raw.password = username || password;
    raw.tls = true;
    applyCommonTransport(raw, parsed.searchParams);
  } else if (type === "vless") {
    raw.uuid = username;
    raw.encryption = parsed.searchParams.get("encryption") ?? "none";
    applyVlessTransport(raw, parsed.searchParams);
  } else if (type === "hysteria2" || type === "hy2") {
    raw.type = "hysteria2";
    raw.password = username || password;
    applyCommonTransport(raw, parsed.searchParams);
    const obfs = parsed.searchParams.get("obfs");
    const obfsPassword = parsed.searchParams.get("obfs-password");
    if (obfs) raw.obfs = obfs;
    if (obfsPassword) raw["obfs-password"] = obfsPassword;
  } else if (type === "tuic") {
    const [uuid, inlinePassword] = username.split(":", 2);
    raw.uuid = uuid;
    raw.password = inlinePassword || password;
    for (const key of ["congestion_control", "udp_relay_mode", "zero_rtt"]) {
      const value = parsed.searchParams.get(key);
      if (value) raw[key.replaceAll("_", "-")] = value;
    }
    applyCommonTransport(raw, parsed.searchParams);
  } else if (type === "socks5" || type === "http") {
    if (username) raw.username = username;
    if (password) raw.password = password;
    applyCommonTransport(raw, parsed.searchParams);
  } else {
    if (username) raw.username = username;
    if (password) raw.password = password;
    applyCommonTransport(raw, parsed.searchParams);
    raw.uri = uri;
  }

  return raw.port ? raw : undefined;
}

/** Parse SIP002's full-base64 form: ss://BASE64(method:password@host:port)#name. */
function parseFullBase64Shadowsocks(uri: string, name: string): RawProxy | undefined {
  const body = uri.slice("ss://".length).split("#", 1)[0] ?? "";
  const queryIndex = body.indexOf("?");
  const encoded = queryIndex === -1 ? body : body.slice(0, queryIndex).replace(/\/$/, "");
  if (!encoded || encoded.includes("@") || encoded.includes(":")) return undefined;

  const decoded = safeDecode(tryDecodeBase64(encoded));
  const at = decoded.lastIndexOf("@");
  if (at <= 0) return undefined;
  const credentials = decoded.slice(0, at);
  const endpoint = decoded.slice(at + 1);
  const separator = credentials.indexOf(":");
  if (separator <= 0 || !endpoint) return undefined;

  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(`ss://${endpoint}`);
  } catch {
    return undefined;
  }
  if (!parsedEndpoint.hostname || !parsedEndpoint.port) return undefined;

  const raw: RawProxy = {
    name,
    type: "ss",
    server: parsedEndpoint.hostname,
    port: Number(parsedEndpoint.port),
    cipher: credentials.slice(0, separator),
    password: credentials.slice(separator + 1)
  };
  if (queryIndex !== -1) {
    parseShadowsocksPlugin(raw, safeDecode(body.slice(queryIndex + 1).replace(/^plugin=/, "")));
  }
  return raw;
}

function parseShadowsocksCredentials(raw: RawProxy, username: string, password: string): void {
  const decoded = tryDecodeBase64(username);
  const value = decoded.includes(":") ? decoded : `${username}:${password}`;
  const separator = value.indexOf(":");
  if (separator <= 0) return;
  raw.cipher = value.slice(0, separator);
  raw.password = value.slice(separator + 1);
}

function parseShadowsocksPlugin(raw: RawProxy, plugin: string | null): void {
  if (!plugin) return;
  const [name, ...options] = safeDecode(plugin).split(";");
  if (!name) return;
  raw.plugin = name;
  const pluginOpts: Record<string, string> = {};
  for (const option of options) {
    const separator = option.indexOf("=");
    if (separator > 0) pluginOpts[option.slice(0, separator)] = option.slice(separator + 1);
  }
  if (Object.keys(pluginOpts).length > 0) raw["plugin-opts"] = pluginOpts;
}

function applyCommonTransport(raw: RawProxy, params: URLSearchParams): void {
  const sni = params.get("sni") ?? params.get("servername") ?? params.get("peer");
  if (sni) raw.sni = sni;
  const insecure = params.get("insecure") ?? params.get("allow-insecure");
  if (insecure) raw["skip-cert-verify"] = insecure === "1" || insecure.toLowerCase() === "true";
  const alpn = params.get("alpn");
  if (alpn) raw.alpn = alpn.split(",").map((item) => item.trim()).filter(Boolean);
  const network = params.get("type") ?? params.get("network");
  if (network && network !== "tcp") raw.network = network;
  const path = params.get("path");
  const host = params.get("host");
  if (path || host) {
    raw["ws-opts"] = {
      ...(path ? { path } : {}),
      ...(host ? { headers: { Host: host } } : {})
    };
  }
}

function applyVlessTransport(raw: RawProxy, params: URLSearchParams): void {
  const security = params.get("security");
  if (security === "tls" || security === "reality") raw.tls = true;
  if (security === "reality") {
    const publicKey = params.get("pbk");
    const shortId = params.get("sid");
    raw["reality-opts"] = {
      ...(publicKey ? { "public-key": publicKey } : {}),
      ...(shortId ? { "short-id": shortId } : {})
    };
  }
  const flow = params.get("flow");
  if (flow) raw.flow = flow;
  const fingerprint = params.get("fp");
  if (fingerprint) raw["client-fingerprint"] = fingerprint;
  applyCommonTransport(raw, params);
  if (raw.network === "grpc") {
    const serviceName = params.get("serviceName") ?? params.get("service-name");
    if (serviceName) raw["grpc-opts"] = { "grpc-service-name": serviceName };
  }
}

function parseSsr(uri: string, name: string): RawProxy | undefined {
  try {
    const encoded = uri.slice("ssr://".length).replace(/-/g, "+").replace(/_/g, "/");
    const decoded = tryDecodeBase64(encoded);
    const [endpoint = "", query = ""] = decoded.split("/?", 2);
    const parts = endpoint.split(":");
    if (parts.length < 6) return undefined;
    const [server, port, protocol, method, obfs, encodedPassword] = parts;
    const raw: RawProxy = {
      name,
      type: "ssr",
      server,
      port: Number(port),
      protocol,
      cipher: method,
      obfs,
      password: tryDecodeBase64(encodedPassword ?? "")
    };
    for (const [key, value] of new URLSearchParams(query)) {
      if (key === "remarks") raw.name = tryDecodeBase64(value);
      if (key === "obfsparam") raw["obfs-param"] = tryDecodeBase64(value);
      if (key === "protoparam") raw["protocol-param"] = tryDecodeBase64(value);
    }
    return raw.port ? raw : undefined;
  } catch {
    return undefined;
  }
}

function decodeUriName(uri: string, fallback: string): string {
  const hashIndex = uri.indexOf("#");
  if (hashIndex === -1) return fallback;
  return safeDecode(uri.slice(hashIndex + 1)) || fallback;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function tryDecodeBase64(value: string): string {
  try {
    const normalized = value.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalized, "base64").toString("utf8");
  } catch {
    return value;
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
