import { describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { createAgentSpawner } from "./codex-tool-agent.js";

/** 起一个本地 http server,handler 决定如何应答;返回 base url + 关闭函数。 */
async function startServer(
  handler: (reqBody: string, send: (status: number, obj: unknown, delayMs?: number) => void) => void
): Promise<{ base: string; close: () => Promise<void>; server: Server }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      handler(Buffer.concat(chunks).toString("utf8"), (status, obj, delayMs = 0) => {
        const body = JSON.stringify(obj);
        setTimeout(() => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(body);
        }, delayMs);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    server
  };
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

describe("createAgentSpawner", () => {
  it("POSTs /run with args/stdin/idempotencyKey + bearer, maps result", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ stdout: "S", stderr: "E", exitCode: 0, timedOut: false, signal: null });
    }) as unknown as typeof fetch;
    const spawn = createAgentSpawner({
      url: "http://agent:8765/",
      token: "tok",
      idempotencyKey: "job-1",
      fetchImpl
    });
    const lines: string[] = [];
    const res = await spawn({
      args: ["login", "--stateless"],
      stdinJson: '{"a":1}',
      timeoutMs: 1000,
      onStderr: (l) => lines.push(l)
    });
    expect(res).toEqual({ stdout: "S", stderr: "E", exitCode: 0, timedOut: false, signal: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://agent:8765/run"); // 末尾斜杠规整
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({
      args: ["login", "--stateless"],
      stdin: '{"a":1}',
      timeoutMs: 1000,
      idempotencyKey: "job-1"
    });
    expect(lines).toEqual(["E"]); // stderr 批量回放
  });

  it("throws on non-ok HTTP", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const spawn = createAgentSpawner({ url: "http://agent:8765", token: "", fetchImpl });
    await expect(spawn({ args: [], stdinJson: null, timeoutMs: 100 })).rejects.toThrow(/HTTP 500/);
  });

  it("maps AbortError → timedOut result (not throw)", async () => {
    const fetchImpl = vi.fn(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as unknown as typeof fetch;
    const spawn = createAgentSpawner({ url: "http://agent:8765", token: "", fetchImpl });
    const res = await spawn({ args: [], stdinJson: null, timeoutMs: 50 });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBeNull();
  });

  // ── 生产 node:http 路径(不注入 fetchImpl)──────────────────────────
  it("node:http 路径：发送 body 正确 + 映射结果", async () => {
    let received = "";
    const srv = await startServer((reqBody, send) => {
      received = reqBody;
      send(200, { stdout: "OUT", stderr: "codex: x\ncodex: y", exitCode: 0, timedOut: false, signal: null });
    });
    try {
      const spawn = createAgentSpawner({ url: srv.base, token: "tok", idempotencyKey: "j9" });
      const lines: string[] = [];
      const res = await spawn({ args: ["all"], stdinJson: "{}", timeoutMs: 2000, onStderr: (l) => lines.push(l) });
      expect(res.stdout).toBe("OUT");
      expect(res.exitCode).toBe(0);
      expect(JSON.parse(received)).toMatchObject({ args: ["all"], stdin: "{}", idempotencyKey: "j9" });
      expect(lines).toEqual(["codex: x", "codex: y"]);
    } finally {
      await srv.close();
    }
  });

  it("node:http 路径：响应头延迟(模拟长 run)不被提前掐断,仍正常返回", async () => {
    // 关键回归：延迟 600ms 才发响应头。旧 fetch 路径有 undici 300s headers 超时;
    // 这里 padding 给足,验证 node:http 不带隐藏 headers 超时、会等到响应。
    const srv = await startServer((_b, send) => {
      send(200, { stdout: "LATE", stderr: "", exitCode: 0, timedOut: false, signal: null }, 600);
    });
    try {
      const spawn = createAgentSpawner({ url: srv.base, token: "", timeoutPaddingMs: 5000 });
      const res = await spawn({ args: ["all"], stdinJson: null, timeoutMs: 2000 });
      expect(res.stdout).toBe("LATE");
    } finally {
      await srv.close();
    }
  });

  // 注：http 路径"总时长到点 → timedOut"的中止逻辑与 fetch 路径同构(destroy→error→ABORTED),
  // 已由上面 "maps AbortError → timedOut result" 覆盖;且总超时下限是 graceMs+35s(>35s),
  // 单测无法快速触发,故不单独测 http 中止。

  it("node:http 路径：非 2xx → 抛 HTTP 错误(含 503 busy)", async () => {
    const srv = await startServer((_b, send) => {
      send(503, { ok: false, error: "agent busy: previous run still in progress" });
    });
    try {
      const spawn = createAgentSpawner({ url: srv.base, token: "" });
      await expect(spawn({ args: [], stdinJson: null, timeoutMs: 1000 })).rejects.toThrow(/HTTP 503/);
    } finally {
      await srv.close();
    }
  });
});
