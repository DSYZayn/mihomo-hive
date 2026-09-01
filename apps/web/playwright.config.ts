import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const dataDir = mkdtempSync(join(tmpdir(), "hive-e2e-"));
const port = process.env.HIVE_E2E_PORT ? Number(process.env.HIVE_E2E_PORT) : 9991;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 15_000
  },
  webServer: {
    command: `node apps/server/dist/index.js`,
    cwd: repoRoot,
    url: `${baseURL}/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      HIVE_HOST: "127.0.0.1",
      HIVE_PORT: String(port),
      HIVE_DATA_DIR: dataDir,
      HIVE_GENERATED_DIR: join(dataDir, "generated"),
      HIVE_CONFIG: join(dataDir, "hive.config.json"),
      HIVE_DATABASE_PATH: join(dataDir, "state.db"),
      // E2E 覆盖 Web 交互，不需要在开发机上启动真实 Mihomo。
      HIVE_DISABLE_MIHOMO_AUTOBOOT: "true"
    }
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
