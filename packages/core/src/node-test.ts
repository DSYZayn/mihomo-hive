import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 直接 TCP connect 到代理 host:port，测握手延迟（L1）。
 * 不走 mihomo、不走业务目标 — 反映"服务到代理"的网络距离。
 *
 * 仅用于普通节点。链式节点不能调用这个直连探测绕过中间跳，必须通过
 * 本地 Mihomo listener 发出业务目标请求来验证完整链路。
 *
 * 返回 { latencyMs, error? }：error 非 null 时 latencyMs 是失败前的耗时。
 */
export async function measureProxyTcpLatency(input: {
  host: string;
  port: number;
  timeoutMs: number;
}): Promise<{ latencyMs: number; error: string | null }> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const finish = (error: string | null) => {
      if (settled) return;
      settled = true;
      const latencyMs = Date.now() - startedAt;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve({ latencyMs, error });
    };
    socket.setTimeout(input.timeoutMs);
    socket.once("connect", () => finish(null));
    socket.once("timeout", () => finish("timeout"));
    socket.once("error", (err) => finish(err.message || "connect_error"));
    try {
      socket.connect(input.port, input.host);
    } catch (err) {
      finish(err instanceof Error ? err.message : "connect_throw");
    }
  });
}

export interface ProxyTestTarget {
  id: string;
  name: string;
  url: string;
  expectedStatuses: number[];
}

export interface ProxyTargetTestResult {
  targetId: string;
  ok: boolean;
  httpStatus?: number;
  latencyMs: number;
  message: string;
}

export const defaultProxyTestTargets: Record<string, ProxyTestTarget> = {
  ip: {
    id: "ip",
    name: "IP echo",
    url: "https://api.ipify.org",
    expectedStatuses: [200]
  },
  openai: {
    id: "openai",
    name: "OpenAI API",
    url: "https://api.openai.com/v1/models",
    expectedStatuses: [401]
  },
  claude: {
    id: "claude",
    name: "Claude API",
    url: "https://api.anthropic.com/v1/messages",
    expectedStatuses: [405]
  }
};

export function localProbeHost(listenHost: string): string {
  if (listenHost === "0.0.0.0") return "127.0.0.1";
  if (listenHost === "::" || listenHost === "[::]") return "::1";
  return listenHost;
}

export function resolveProxyTestTargets(ids: string[]): ProxyTestTarget[] {
  return ids.map((id) => {
    const target = defaultProxyTestTargets[id];
    if (!target) {
      throw new Error(`Unknown test target: ${id}. Available: ${Object.keys(defaultProxyTestTargets).join(", ")}`);
    }
    return target;
  });
}

export async function testProxyTarget(input: {
  host: string;
  port: number;
  target: ProxyTestTarget;
  timeoutMs: number;
}): Promise<ProxyTargetTestResult> {
  const startedAt = Date.now();
  const maxTimeSeconds = Math.max(1, Math.ceil(input.timeoutMs / 1000));

  try {
    const { stdout } = await execFileAsync(
      "curl",
      [
        "-sS",
        "--max-time",
        String(maxTimeSeconds),
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "-x",
        `socks5h://${input.host}:${input.port}`,
        input.target.url
      ],
      { timeout: input.timeoutMs + 1000 }
    );
    const latencyMs = Date.now() - startedAt;
    const httpStatus = Number(String(stdout).trim());
    const ok = input.target.expectedStatuses.includes(httpStatus);
    return {
      targetId: input.target.id,
      ok,
      httpStatus,
      latencyMs,
      message: ok ? "ok" : `unexpected_http_${httpStatus || "none"}`
    };
  } catch (error) {
    return {
      targetId: input.target.id,
      ok: false,
      latencyMs: Date.now() - startedAt,
      message: summarizeError(error)
    };
  }
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index] as T, index);
      }
    })
  );

  return results;
}

function summarizeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "unknown_error";
  }
  const detail = error as Error & {
    code?: string | number;
    killed?: boolean;
    signal?: string;
    stderr?: string;
  };
  if (detail.killed || detail.signal === "SIGTERM" || /timed out|timeout/i.test(error.message)) {
    return "timeout";
  }
  const stderrLine = detail.stderr?.split(/\r?\n/).find(Boolean);
  if (stderrLine) {
    return stderrLine.replace(/^curl:\s*/i, "curl_").slice(0, 160);
  }
  if (detail.code !== undefined) {
    return `exit_${detail.code}`;
  }
  return "curl_failed";
}
