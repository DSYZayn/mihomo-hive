import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { RuntimeConfig } from "@mihomo-hive/schemas";

export interface MihomoStatus {
  running: boolean;
  pid?: number;
}

/** external-controller 地址规范成 http base（配置可能是 "127.0.0.1:9090" 或带 scheme）。 */
function controllerBase(externalController: string): string {
  const v = externalController.trim();
  return v.startsWith("http://") || v.startsWith("https://") ? v : `http://${v}`;
}

/**
 * 运行时切换某个 select 代理组的当前选择(Mihomo external-controller `PUT /proxies/{group}`)。
 * 用于"单口 + 动态上游":Hive 选好出口节点后,把 codex-egress 组切到该节点,远程 codex-tool
 * 经那个唯一鉴权口出去时即走该节点。瞬时生效、无需 reload。
 */
export async function setProxyGroupSelection(
  config: RuntimeConfig,
  group: string,
  proxyName: string
): Promise<void> {
  const url = `${controllerBase(config.externalController)}/proxies/${encodeURIComponent(group)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(config.externalControllerSecret
        ? { authorization: `Bearer ${config.externalControllerSecret}` }
        : {})
    },
    body: JSON.stringify({ name: proxyName })
  });
  // Mihomo 成功返回 204；其余视为失败
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`mihomo 切换出口组失败 ${group}→${proxyName}: HTTP ${res.status} ${text}`.trim());
  }
}

export async function readMihomoStatus(config: RuntimeConfig): Promise<MihomoStatus> {
  try {
    const pid = Number((await readFile(config.mihomoPidPath, "utf8")).trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      return { running: false };
    }
    process.kill(pid, 0);
    // pid 存在 ≠ 是 mihomo。容器重建后 /data/mihomo.pid（挂载卷）残留旧 pid，新容器里
    // 该 pid 可能被别的进程占用 → 误判 running → mihomo 永不启动 → 所有代理失效。
    // 在 Linux 用 /proc/{pid}/cmdline 校验确实是 mihomo；非 Linux（开发机）/proc 读不到
    // 时退回只靠 kill 探活（保持原行为）。
    if (!processIsMihomo(pid)) {
      return { running: false };
    }
    return { running: true, pid };
  } catch {
    return { running: false };
  }
}

/**
 * 校验 pid 对应进程确实是 mihomo（防容器重建后残留 pidfile 误判）。
 * 读 /proc/{pid}/cmdline：含 "mihomo" 才算。/proc 不存在（非 Linux）→ 返回 true
 * 退回 kill 探活语义，不破坏开发机行为。
 */
function processIsMihomo(pid: number): boolean {
  try {
    // cmdline 用 \0 分隔参数；mihomo 二进制路径里含 "mihomo"
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (!cmdline) return true; // 空读不到 → 不否定
    return cmdline.toLowerCase().includes("mihomo");
  } catch {
    return true; // /proc 不可用 → 保持原 kill 探活结果
  }
}

export async function startMihomo(config: RuntimeConfig): Promise<MihomoStatus> {
  const status = await readMihomoStatus(config);
  if (status.running) {
    return status;
  }

  // 残留 pidfile 指向死进程时直接删掉，避免一遍遍读到同一个死 pid。
  await rm(config.mihomoPidPath, { force: true });

  await mkdir(dirname(config.mihomoPidPath), { recursive: true });
  await mkdir(dirname(config.mihomoLogPath), { recursive: true });

  if (!existsSync(config.mihomoConfigPath)) {
    throw new Error(`Mihomo config does not exist: ${config.mihomoConfigPath}`);
  }

  const logFd = openSync(config.mihomoLogPath, "a");
  const child = spawn(config.mihomoBin, ["-d", config.dataDir, "-f", config.mihomoConfigPath], {
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  closeSync(logFd);

  if (!child.pid) {
    throw new Error("Failed to start Mihomo");
  }

  await writeFile(config.mihomoPidPath, `${child.pid}\n`);

  // spawn 成功 ≠ mihomo 真的活着：配置错误 / 端口被占 / 二进制异常都会让它
  // 启动即退。等一小段启动窗口后复检，死了就把 log 尾部抛出来，否则用户
  // 只能看到"未运行"却永远不知道原因、也无法手动恢复。
  await waitForProcessBoot(child.pid, 1200);
  if (processAlive(child.pid)) {
    return { running: true, pid: child.pid };
  }

  await rm(config.mihomoPidPath, { force: true });
  const tail = readLogTail(config.mihomoLogPath, 4000);
  throw new Error(
    `Mihomo 启动后立即退出 (pid ${child.pid})。` +
      (tail ? `\n日志尾部：\n${tail}` : "\n日志为空，请检查 mihomo 二进制与配置路径。")
  );
}

export async function stopMihomo(config: RuntimeConfig): Promise<MihomoStatus> {
  const status = await readMihomoStatus(config);
  if (!status.running) {
    // pidfile 可能已丢但进程还活着（占着端口），尽力按端口/二进制清理由系统层兜底；
    // 这里至少把残留 pidfile 清掉，保证下一次 start 不被死 pid 卡住。
    await rm(config.mihomoPidPath, { force: true });
    return { running: false };
  }
  if (status.pid) {
    try {
      process.kill(status.pid, "SIGTERM");
    } catch {
      // 已退出
    }
  }
  await rm(config.mihomoPidPath, { force: true });
  return { running: false };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return processIsMihomo(pid);
  } catch {
    return false;
  }
}

function waitForProcessBoot(_pid: number, ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 读 mihomo 日志尾部用于启动失败报错；文件不存在/读失败时返回空串。 */
function readLogTail(logPath: string, maxBytes: number): string {
  try {
    if (!existsSync(logPath)) return "";
    const size = statSync(logPath).size;
    const start = Math.max(0, size - maxBytes);
    const fd = openSync(logPath, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf8").trim();
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

export async function reloadMihomo(config: RuntimeConfig): Promise<MihomoStatus> {
  const status = await readMihomoStatus(config);
  if (!status.running || !status.pid) {
    return startMihomo(config);
  }
  process.kill(status.pid, "SIGHUP");
  return status;
}
