import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  defaultRuntimeConfig,
  parseRuntimeConfig,
  type RuntimeConfig
} from "@mihomo-hive/schemas";

export function resolveConfigPath(pathFromEnv = process.env.HIVE_CONFIG): string {
  return resolve(pathFromEnv ?? "runtime/hive.config.json");
}

export async function loadRuntimeConfig(configPath = resolveConfigPath()): Promise<RuntimeConfig> {
  try {
    const raw = await readFile(configPath, "utf8");
    return withEnvOverrides(parseRuntimeConfig(JSON.parse(raw)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return withEnvOverrides(defaultRuntimeConfig);
  }
}

export async function writeRuntimeConfig(
  config: RuntimeConfig,
  configPath = resolveConfigPath()
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const persisted = parseRuntimeConfig(config);
  // Runtime credentials come from the deployment environment, not the saved config.
  delete persisted.proxyAuth;
  await writeFile(configPath, `${JSON.stringify(persisted, null, 2)}\n`);
}

function withEnvOverrides(config: RuntimeConfig): RuntimeConfig {
  const dataDir = process.env.HIVE_DATA_DIR ?? config.dataDir;
  const generatedDir = process.env.HIVE_GENERATED_DIR ?? config.generatedDir;
  const username = process.env.HIVE_PROXY_USERNAME;
  const password = process.env.HIVE_PROXY_PASSWORD;
  if (Boolean(username) !== Boolean(password)) {
    throw new Error("HIVE_PROXY_USERNAME and HIVE_PROXY_PASSWORD must both be set or both be empty");
  }
  const next = {
    ...config,
    dataDir,
    generatedDir,
    listenHost: process.env.HIVE_LISTEN_HOST || config.listenHost,
    exportHost: process.env.HIVE_EXPORT_HOST || config.exportHost,
    proxyAuth: username && password ? { username, password } : undefined,
    subscriptionUserAgent: process.env.HIVE_SUBSCRIPTION_USER_AGENT || config.subscriptionUserAgent,
    databasePath: process.env.HIVE_DATABASE_PATH ?? config.databasePath,
    mihomoBin: process.env.MIHOMO_BIN ?? config.mihomoBin,
    mihomoConfigPath: process.env.MIHOMO_CONFIG_PATH ?? config.mihomoConfigPath,
    mihomoPidPath: process.env.MIHOMO_PID_PATH ?? config.mihomoPidPath,
    mihomoLogPath: process.env.MIHOMO_LOG_PATH ?? config.mihomoLogPath
  };

  if (process.env.HIVE_DATA_DIR && config.databasePath === defaultRuntimeConfig.databasePath) {
    next.databasePath = `${dataDir}/state.db`;
  }
  if (process.env.HIVE_DATA_DIR && config.mihomoPidPath === defaultRuntimeConfig.mihomoPidPath) {
    next.mihomoPidPath = `${dataDir}/mihomo.pid`;
  }
  if (process.env.HIVE_DATA_DIR && config.mihomoLogPath === defaultRuntimeConfig.mihomoLogPath) {
    next.mihomoLogPath = `${dataDir}/logs/mihomo.log`;
  }
  if (process.env.HIVE_GENERATED_DIR && config.mihomoConfigPath === defaultRuntimeConfig.mihomoConfigPath) {
    next.mihomoConfigPath = `${generatedDir}/mihomo.yaml`;
  }

  return parseRuntimeConfig(next);
}
