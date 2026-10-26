import { z } from "zod";

const proxyCredentialSchema = z.string().min(1)
  .refine((value) => new TextEncoder().encode(value).length <= 255, "Proxy credentials must be at most 255 UTF-8 bytes")
  .refine((value) => !/[\x00-\x1f\x7f|]/.test(value), "Proxy credentials cannot contain control characters or |");

export const proxyAuthSchema = z.object({
  username: proxyCredentialSchema.refine((value) => !value.includes(":"), "Proxy username cannot contain :"),
  password: proxyCredentialSchema
});
export type ProxyAuth = z.infer<typeof proxyAuthSchema>;

export const runtimeConfigSchema = z.object({
  listenHost: z.string().min(1).default("127.0.0.1"),
  exportHost: z.string().min(1).default("127.0.0.1"),
  proxyAuth: proxyAuthSchema.optional(),
  portRangeStart: z.number().int().min(1).max(65535).default(10001),
  portRangeEnd: z.number().int().min(1).max(65535).default(10300),
  dataDir: z.string().min(1).default("runtime"),
  generatedDir: z.string().min(1).default("generated"),
  databasePath: z.string().min(1).default("runtime/state.db"),
  mihomoBin: z.string().min(1).default("mihomo"),
  mihomoConfigPath: z.string().min(1).default("generated/mihomo.yaml"),
  mihomoPidPath: z.string().min(1).default("runtime/mihomo.pid"),
  mihomoLogPath: z.string().min(1).default("runtime/logs/mihomo.log"),
  externalController: z.string().min(1).default("127.0.0.1:9090"),
  externalControllerSecret: z.string().default(""),
  subscriptionUserAgent: z.string().min(1).default("Clash.Meta")
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export const defaultRuntimeConfig: RuntimeConfig = runtimeConfigSchema.parse({});

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  const config = runtimeConfigSchema.parse(value);
  if (config.portRangeEnd < config.portRangeStart) {
    throw new Error("portRangeEnd must be greater than or equal to portRangeStart");
  }
  return config;
}
