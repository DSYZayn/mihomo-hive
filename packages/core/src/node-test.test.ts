import { describe, expect, it, vi } from "vitest";
import { buildProxyUrl } from "./proxy-access.js";
import { testProxyTarget } from "./node-test.js";

const runCurl = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: runCurl }) };
});

describe("authenticated proxy requests", () => {
  const auth = { username: "user@hive", password: "p:a@ss/#% ?测试" };

  it("escapes credentials and brackets IPv6 while preserving the old unauthenticated URL", () => {
    expect(buildProxyUrl({ protocol: "http", host: "127.0.0.1", port: 10001 })).toBe("http://127.0.0.1:10001");
    const result = new URL(buildProxyUrl({ protocol: "http", host: "::1", port: 10001, auth }));
    expect(result.hostname).toBe("[::1]");
    expect(decodeURIComponent(result.username)).toBe(auth.username);
    expect(decodeURIComponent(result.password)).toBe(auth.password);
  });

  it("passes credentials to the SOCKS5 health probe", async () => {
    runCurl.mockResolvedValueOnce({ stdout: "401", stderr: "" });
    const result = await testProxyTarget({
      host: "127.0.0.1", port: 10001, auth, timeoutMs: 1000,
      target: { id: "openai", name: "OpenAI", url: "https://api.openai.com/v1/models", expectedStatuses: [401] }
    });
    expect(result.ok).toBe(true);
    const args = runCurl.mock.calls.at(-1)![1] as string[];
    const proxy = new URL(args[args.indexOf("-x") + 1]!);
    expect(proxy.protocol).toBe("socks5h:");
    expect(decodeURIComponent(proxy.username)).toBe(auth.username);
    expect(decodeURIComponent(proxy.password)).toBe(auth.password);
  });

  it("does not expose command-line credentials in a failed probe result", async () => {
    runCurl.mockRejectedValueOnce(Object.assign(new Error(`Command failed: curl -x ${buildProxyUrl({ protocol: "socks5h", host: "localhost", port: 10001, auth })}`), { code: 97 }));
    const result = await testProxyTarget({
      host: "localhost", port: 10001, auth, timeoutMs: 1000,
      target: { id: "test", name: "test", url: "https://example.com", expectedStatuses: [200] }
    });
    expect(result).toMatchObject({ ok: false, message: "exit_97" });
  });
});
