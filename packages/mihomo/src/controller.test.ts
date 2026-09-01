import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRuntimeConfig } from "@mihomo-hive/schemas";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMihomoStatus, setProxyGroupSelection, startMihomo } from "./controller.js";

describe("setProxyGroupSelection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("PUT /proxies/{group} with {name} + bearer secret", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    }));
    const cfg = { ...defaultRuntimeConfig, externalController: "127.0.0.1:9090", externalControllerSecret: "sek" };
    await setProxyGroupSelection(cfg, "codex-egress", "hive-001-abc");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:9090/proxies/codex-egress");
    expect(calls[0]!.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ name: "hive-001-abc" });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sek");
  });

  it("throws on non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    await expect(setProxyGroupSelection(defaultRuntimeConfig, "g", "p")).rejects.toThrow(/失败/);
  });
});

describe("startMihomo", () => {
  function makeConfig(dir: string, bin: string) {
    return {
      ...defaultRuntimeConfig,
      dataDir: dir,
      mihomoBin: bin,
      mihomoConfigPath: join(dir, "mihomo.yaml"),
      mihomoPidPath: join(dir, "mihomo.pid"),
      mihomoLogPath: join(dir, "logs", "mihomo.log")
    };
  }

  it("启动即退时抛出带日志尾部的错误并清掉 pidfile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-mihomo-"));
    writeFileSync(join(dir, "mihomo.yaml"), "port: 7890\n");
    // 用一个必然瞬间退出的"假 mihomo"：node -e process.exit(1)
    const config = makeConfig(dir, process.execPath);
    // spawn 参数是 ["-d", dir, "-f", cfg]，node 会把 "-d" 当脚本名直接报错退出 —— 正好模拟启动即崩。
    await expect(startMihomo(config)).rejects.toThrow(/Mihomo 启动后立即退出/);
    expect(existsSync(config.mihomoPidPath)).toBe(false);
    // 失败后再读状态应是未运行（pidfile 已清，不会卡死 pid）
    await expect(readMihomoStatus(config)).resolves.toEqual({ running: false });
  }, 15000);

  it("配置文件缺失时直接报错，不写 pidfile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-mihomo-"));
    const config = makeConfig(dir, process.execPath);
    await expect(startMihomo(config)).rejects.toThrow(/Mihomo config does not exist/);
    expect(existsSync(config.mihomoPidPath)).toBe(false);
  });
});
