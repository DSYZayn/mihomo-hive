import {
  SUB2API_PROXY_NAME_MAX_BYTES,
  sub2ApiExportPreviewSchema,
  sub2ApiExportSchema,
  type Sub2ApiExportPreview,
  type ProxyNode,
  type Sub2ApiExport
} from "@mihomo-hive/schemas";

export interface ExportSub2ApiOptions {
  host: string;
  username?: string;
  password?: string;
  selectedHashes?: string[];
  failedNodeStatus?: "active" | "inactive";
  namePrefix?: string | undefined;
}

export function exportSub2Api(nodes: ProxyNode[], options: ExportSub2ApiOptions): Sub2ApiExport {
  const selected = normalizeSelectedHashes(options.selectedHashes);
  const proxies = filterExportableNodes(nodes, selected)
    .sort((a, b) => Number(a.assignedPort) - Number(b.assignedPort))
    .map((node) => {
      const protocol = "socks5" as const;
      const username = readOptionalString(options.username);
      const password = readOptionalString(options.password);
      const proxyKey = [protocol, options.host, Number(node.assignedPort), username ?? "", password ?? ""].join("|");
      return {
        proxy_key: proxyKey,
        name: exportProxyName(node, options.namePrefix ?? ""),
        protocol,
        host: options.host,
        port: Number(node.assignedPort),
        ...(username ? { username } : {}),
        ...(password ? { password } : {}),
        status: resolveExportStatus(node, options.failedNodeStatus ?? "inactive")
      };
    });

  return sub2ApiExportSchema.parse({
    proxies,
    accounts: []
  });
}

function exportProxyName(node: ProxyNode, prefix: string): string {
  const encoder = new TextEncoder();
  const name = `${prefix}${node.name}`;
  if (encoder.encode(name).length <= SUB2API_PROXY_NAME_MAX_BYTES) return name;

  // The remote limit is measured in UTF-8 bytes; reserve the managed prefix and listener identity.
  const suffix = `-${node.assignedPort}`;
  const budget = SUB2API_PROXY_NAME_MAX_BYTES - encoder.encode(prefix + suffix).length;
  if (budget <= 0) {
    throw new Error("Sub2API managed proxy prefix is too long; shorten it before syncing.");
  }
  let truncated = "";
  let bytes = 0;
  for (const character of node.name) {
    const size = encoder.encode(character).length;
    if (bytes + size > budget) break;
    truncated += character;
    bytes += size;
  }
  return `${prefix}${truncated}${suffix}`;
}

export function previewSub2ApiExport(nodes: ProxyNode[], options: ExportSub2ApiOptions): Sub2ApiExportPreview {
  const selected = normalizeSelectedHashes(options.selectedHashes);
  const selectedCount = selected ? selected.size : nodes.filter((node) => node.assignedPort).length;
  const excluded = nodes
    .map((node) => {
      if (selected && !selected.has(node.hash)) {
        return { hash: node.hash, name: node.name, reason: "not_selected" as const };
      }
      if (!node.assignedPort) {
        return { hash: node.hash, name: node.name, reason: "missing_port" as const };
      }
      return undefined;
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const payload = exportSub2Api(nodes, options);

  return sub2ApiExportPreviewSchema.parse({
    export: payload,
    selected: selectedCount,
    exportable: payload.proxies.length,
    excluded,
    summary: {
      notSelected: excluded.filter((item) => item.reason === "not_selected").length,
      notActive: 0,
      missingPort: excluded.filter((item) => item.reason === "missing_port").length
    }
  });
}

function filterExportableNodes(nodes: ProxyNode[], selectedHashes?: Set<string>): ProxyNode[] {
  return nodes.filter((node) => {
    if (selectedHashes && !selectedHashes.has(node.hash)) {
      return false;
    }
    return Boolean(node.assignedPort) && node.lifecycleStatus !== "deleted" && node.lifecycleStatus !== "retired";
  });
}

function normalizeSelectedHashes(selectedHashes: string[] | undefined): Set<string> | undefined {
  if (!selectedHashes) {
    return undefined;
  }
  return new Set(selectedHashes);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveExportStatus(node: ProxyNode, failedNodeStatus: "active" | "inactive"): "active" | "inactive" {
  if (node.status === "active") {
    return "active";
  }
  if (node.status === "failed") {
    return failedNodeStatus;
  }
  return "inactive";
}
