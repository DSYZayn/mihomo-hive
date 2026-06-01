/**
 * codex-tool 外置 Agent 的 HTTP spawner —— 把"本地起 codex-tool 子进程"换成"POST 到
 * 桌面 agent 的 /run"。adapter / worker / 信封解析全不变,只换这一层传输。
 *
 * 契约与 `codex-tool serve` 对齐：
 *   POST {url}/run  (Authorization: Bearer <token>)
 *     body  {args, stdin, timeoutMs, graceMs, idempotencyKey?}
 *     resp  {stdout, stderr, exitCode, timedOut, signal}
 *
 * 注意:HTTP 是请求/响应,stderr 只在结束时一次性拿到 → onStderr 收尾时批量回放(日志进 job,
 * 非实时)。idempotencyKey 让 agent 对"已完成结果"去重(防响应丢失重复执行)。
 *
 * ⚠ 为什么生产路径用 node:http 而不是全局 fetch：
 *   agent 的 /run 是"一个长请求,跑完才返回响应头"。注册的地区轮换可能合法地跑很久(分钟级)。
 *   但 Node 内置 fetch(undici)默认 `headersTimeout`/`bodyTimeout` = 300s——300s 没收到响应头
 *   就 abort 报 `fetch failed`,即使我们的 AbortController 设的是 timeoutMs+padding(远大于 300s)
 *   也没机会触发。实测后果:Hive 在 300s 误判失败 → 派下一个任务 → 撞上 agent 那头还在跑的旧 run
 *   → 503 busy 级联。node:http 不带这种隐藏的 headers 超时,只受我们显式的总时长硬上限控制,
 *   会一直等到 agent 真正返回。注入了 fetchImpl 的测试仍走 fetch 分支。
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { CodexToolSpawner, CodexToolSpawnRequest, CodexToolSpawnResult } from "./codex-tool.js";

export interface AgentSpawnerOptions {
  /** agent 基址,如 http://192.168.5.20:8765 。 */
  url: string;
  /** 共享 bearer token;空则不带鉴权头。 */
  token: string;
  /** 幂等键(通常用 job id);agent 据此缓存已完成结果。 */
  idempotencyKey?: string;
  /** HTTP 超时在 codex 超时之上的余量(ms)。 */
  timeoutPaddingMs?: number;
  /** 测试可注入 fetch；注入则走 fetch 分支,否则生产走 node:http。 */
  fetchImpl?: typeof fetch;
}

interface AgentRunResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  signal?: string | null;
}

const ABORTED_RESULT: CodexToolSpawnResult = {
  stdout: "",
  stderr: "agent request aborted (timeout)",
  exitCode: null,
  timedOut: true,
  signal: null
};

export function createAgentSpawner(opts: AgentSpawnerOptions): CodexToolSpawner {
  const base = opts.url.replace(/\/+$/, "");
  const padding = opts.timeoutPaddingMs ?? 30_000;

  return async (req: CodexToolSpawnRequest): Promise<CodexToolSpawnResult> => {
    const payload = JSON.stringify({
      args: req.args,
      stdin: req.stdinJson,
      timeoutMs: req.timeoutMs,
      graceMs: req.graceMs ?? 15_000,
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {})
    });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {})
    };
    // 总时长硬上限：等到 agent 真正返回为止(覆盖合法的长 run，如地区轮换)。
    // 关键下限：agent 在 timeoutMs + graceMs + 30s 时才"强制放锁"(见 agent_server 硬超时 join)。
    // Hive 必须等过这个点再放弃,否则会落在"Hive 以为结束、agent 还占着 run_lock"的窗口里,把
    // 下一个任务派进去撞 503 busy。所以 padding 取 max(配置值, graceMs+35s) 作为安全下限。
    const graceMs = req.graceMs ?? 15_000;
    const totalTimeoutMs = req.timeoutMs + Math.max(padding, graceMs + 35_000);

    const body = opts.fetchImpl
      ? await runViaFetch(opts.fetchImpl, `${base}/run`, headers, payload, totalTimeoutMs)
      : await runViaHttp(`${base}/run`, headers, payload, totalTimeoutMs);
    if (body === "ABORTED") return ABORTED_RESULT;

    const stderr = body.stderr ?? "";
    // 批量回放 stderr(非实时):让 worker 的 appendJobLog 仍拿到 codex: 进度行
    if (req.onStderr && stderr) {
      for (const line of stderr.split("\n")) {
        if (line.trim()) req.onStderr(line);
      }
    }
    return {
      stdout: body.stdout ?? "",
      stderr,
      exitCode: body.exitCode ?? null,
      timedOut: Boolean(body.timedOut),
      signal: (body.signal as NodeJS.Signals | null) ?? null
    };
  };
}

/** 生产路径：node:http(s)。只受总时长硬上限控制,不带 undici 的隐藏 headers/body 超时。 */
function runViaHttp(
  url: string,
  headers: Record<string, string>,
  payload: string,
  totalTimeoutMs: number
): Promise<AgentRunResponse | "ABORTED"> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const reqFn = target.protocol === "https:" ? httpsRequest : httpRequest;
    let aborted = false;
    const request = reqFn(
      target,
      { method: "POST", headers: { ...headers, "content-length": String(Buffer.byteLength(payload)) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          clearTimeout(timer);
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status >= 400) {
            reject(new Error(`codex-tool agent HTTP ${status}: ${text.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(text) as AgentRunResponse);
          } catch (err) {
            reject(new Error(`codex-tool agent 返回非法 JSON: ${(err as Error).message}`));
          }
        });
      }
    );
    // 总时长到点：销毁连接,按"超时中止"语义返回(与 fetch 分支一致)。
    // 必须传入 error,否则 destroy() 不一定触发 'error' 事件 → Promise 永挂。
    const timer = setTimeout(() => {
      aborted = true;
      request.destroy(new Error("agent request timeout"));
    }, totalTimeoutMs);
    request.on("error", (err) => {
      clearTimeout(timer);
      if (aborted) resolve("ABORTED");
      else reject(err);
    });
    request.write(payload);
    request.end();
  });
}

/** 测试路径：注入的 fetchImpl(行为与旧实现一致,带 AbortController 总超时)。 */
async function runViaFetch(
  doFetch: typeof fetch,
  url: string,
  headers: Record<string, string>,
  payload: string,
  totalTimeoutMs: number
): Promise<AgentRunResponse | "ABORTED"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), totalTimeoutMs);
  try {
    const res = await doFetch(url, { method: "POST", headers, body: payload, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`codex-tool agent HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as AgentRunResponse;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return "ABORTED";
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}
