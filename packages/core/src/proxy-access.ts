import type { ProxyAuth } from "@mihomo-hive/schemas";

/** Encode credentials separately so punctuation cannot change the proxy endpoint. */
export function buildProxyUrl(input: {
  protocol: "http" | "socks5h";
  host: string;
  port: number;
  auth?: ProxyAuth | undefined;
}): string {
  const host = input.host.includes(":") && !input.host.startsWith("[") ? `[${input.host}]` : input.host;
  const userInfo = input.auth
    ? `${encodeURIComponent(input.auth.username)}:${encodeURIComponent(input.auth.password)}@`
    : "";
  return `${input.protocol}://${userInfo}${host}:${input.port}`;
}
