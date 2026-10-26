import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfig, writeRuntimeConfig } from "./config.js";

describe("proxy environment configuration", () => {
  let directory: string;
  let path: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "hive-proxy-config-"));
    path = join(directory, "hive.config.json");
    for (const key of ["HIVE_PROXY_USERNAME", "HIVE_PROXY_PASSWORD", "HIVE_LISTEN_HOST", "HIVE_EXPORT_HOST"]) {
      vi.stubEnv(key, undefined);
    }
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps authentication off when unset or both empty", async () => {
    expect((await loadRuntimeConfig(path)).proxyAuth).toBeUndefined();
    vi.stubEnv("HIVE_PROXY_USERNAME", "");
    vi.stubEnv("HIVE_PROXY_PASSWORD", "");
    expect((await loadRuntimeConfig(path)).proxyAuth).toBeUndefined();
  });

  it("applies environment settings over an existing deployment config without persisting credentials", async () => {
    await writeFile(path, JSON.stringify({ listenHost: "127.0.0.1", exportHost: "127.0.0.1" }));
    vi.stubEnv("HIVE_LISTEN_HOST", "0.0.0.0");
    vi.stubEnv("HIVE_EXPORT_HOST", "proxy.example.com");
    vi.stubEnv("HIVE_PROXY_USERNAME", "hive");
    vi.stubEnv("HIVE_PROXY_PASSWORD", "p@ss:word#% /测试");
    const config = await loadRuntimeConfig(path);
    expect(config).toMatchObject({
      listenHost: "0.0.0.0", exportHost: "proxy.example.com",
      proxyAuth: { username: "hive", password: "p@ss:word#% /测试" }
    });
    await writeRuntimeConfig(config, path);
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved).not.toHaveProperty("proxyAuth");
    expect((await loadRuntimeConfig(path)).proxyAuth).toEqual(config.proxyAuth);
  });

  it.each([["user", ""], ["", "password"], ["user", undefined], [undefined, "password"]])(
    "rejects partial credentials (%s, %s)", async (username, password) => {
      vi.stubEnv("HIVE_PROXY_USERNAME", username);
      vi.stubEnv("HIVE_PROXY_PASSWORD", password);
      await expect(loadRuntimeConfig(path)).rejects.toThrow("must both be set");
    }
  );

  it.each([
    ["user:name", "password"], ["user|name", "password"], ["user", "pass|word"],
    ["user", "pass\nword"], ["user", "密".repeat(86)], ["u".repeat(256), "password"]
  ])("rejects credentials incompatible with mixed proxies or proxy_key (%s)", async (username, password) => {
    vi.stubEnv("HIVE_PROXY_USERNAME", username);
    vi.stubEnv("HIVE_PROXY_PASSWORD", password);
    await expect(loadRuntimeConfig(path)).rejects.toThrow();
  });
});
