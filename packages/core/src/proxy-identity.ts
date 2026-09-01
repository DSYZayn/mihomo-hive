import { canonicalProxyIdentity } from "@mihomo-hive/schemas";
import { sha256 } from "./hash.js";

/**
 * Build a stable identity for a proxy connection.
 * Provider display names and URI fragments are intentionally ignored so a
 * refresh cannot create a second local node for the same endpoint.
 */
export function proxyIdentityHash(raw: Record<string, unknown>): string {
  return sha256(canonicalProxyIdentity(raw));
}
