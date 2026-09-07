import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnState = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnState.spawn }));

import { writeMihomoConfig } from "./controller.js";

describe("writeMihomoConfig", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hive-mihomo-config-"));
    spawnState.spawn.mockReset();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("validates through Mihomo before replacing the live config", async () => {
    const configPath = join(tempDir, "mihomo.yaml");
    writeFileSync(configPath, "old-config");
    const child = fakeChild();
    spawnState.spawn.mockImplementation((_command: string, args: string[]) => {
      expect(args[0]).toBe("-t");
      expect(args[1]).toBe("-d");
      expect(args[3]).toBe("-f");
      expect(args[4]).toContain("mihomo.yaml.tmp-");
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    });

    await writeMihomoConfig(testConfig(configPath), "new-config");

    expect(readFileSync(configPath, "utf8")).toBe("new-config");
  });

  it("keeps the previous config when Mihomo rejects the candidate", async () => {
    const configPath = join(tempDir, "mihomo.yaml");
    writeFileSync(configPath, "old-config");
    const child = fakeChild();
    spawnState.spawn.mockImplementation(() => {
      queueMicrotask(() => {
        child.stderr.emit("data", "unset fields: alterId");
        child.emit("close", 1, null);
      });
      return child;
    });

    await expect(
      writeMihomoConfig(testConfig(configPath), "bad-config"),
    ).rejects.toThrow(/旧配置未修改/);
    expect(readFileSync(configPath, "utf8")).toBe("old-config");
  });
});

function fakeChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function testConfig(configPath: string) {
  return {
    listenHost: "127.0.0.1",
    exportHost: "127.0.0.1",
    portRangeStart: 10001,
    portRangeEnd: 10300,
    dataDir: join(tempDirFor(configPath), "data"),
    generatedDir: tempDirFor(configPath),
    databasePath: join(tempDirFor(configPath), "state.db"),
    mihomoBin: "mihomo",
    mihomoConfigPath: configPath,
    mihomoPidPath: join(tempDirFor(configPath), "mihomo.pid"),
    mihomoLogPath: join(tempDirFor(configPath), "mihomo.log"),
    externalController: "127.0.0.1:9090",
    externalControllerSecret: "",
    subscriptionUserAgent: "Clash.Meta",
  };
}

function tempDirFor(path: string): string {
  return join(path, "..");
}
