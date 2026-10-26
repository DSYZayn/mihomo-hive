import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import net from "node:net";
import { once } from "node:events";
import { fetchSubscriptionText, subscriptionProxyEnvironment } from "./subscription-fetch.js";

const servers: Server[] = [];
const content = "proxies:\n  - name: Test\n    type: socks5\n    server: example.com\n    port: 1080\n";

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as net.AddressInfo).port;
}

function environment(values: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (["http_proxy", "https_proxy", "all_proxy", "no_proxy"].includes(key.toLowerCase())) delete env[key];
  }
  return { ...env, ...values };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

describe("subscription downloads through environment proxies", () => {
  it("normalizes Docker uppercase proxy variables and gives lowercase values precedence", () => {
    const result = subscriptionProxyEnvironment({ HTTP_PROXY: "http://upper", http_proxy: "http://lower", HTTPS_PROXY: "http://secure", ALL_PROXY: "socks5h://all", NO_PROXY: "localhost" });
    expect(result).toEqual({ http_proxy: "http://lower", https_proxy: "http://secure", all_proxy: "socks5h://all", no_proxy: "localhost" });
  });

  it("uses an authenticated HTTP proxy and sends the subscription User-Agent", async () => {
    let seenUrl: string | undefined;
    let seenAgent: string | undefined;
    const port = await listen(createServer((req, res) => {
      seenUrl = req.url;
      seenAgent = req.headers["user-agent"];
      if (req.headers["proxy-authorization"] !== `Basic ${Buffer.from("user:p@ss").toString("base64")}`) {
        res.writeHead(407); res.end(); return;
      }
      res.end(content);
    }));
    expect(await fetchSubscriptionText("http://subscription.invalid/sub?token=private-token", {
      env: environment({ HTTP_PROXY: `http://user:p%40ss@127.0.0.1:${port}` })
    })).toBe(content);
    expect(seenUrl).toBe("http://subscription.invalid/sub?token=private-token");
    expect(seenAgent).toBe("Clash.Meta");
  });

  it("uses HTTPS_PROXY for CONNECT and reports proxy authentication failure without leaking credentials", async () => {
    let connected = false;
    const proxy = createServer();
    proxy.on("connect", (_req, socket) => {
      connected = true;
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    const port = await listen(proxy);
    const result = await fetchSubscriptionText("https://subscription.invalid/sub?token=private-token", {
      env: environment({ HTTPS_PROXY: `http://secret-user:secret-password@127.0.0.1:${port}` })
    }).catch((error: Error) => error.message);
    expect(connected).toBe(true);
    expect(result).toContain("HTTP 407");
    expect(result).not.toMatch(/private-token|secret-user|secret-password/);
  });

  it("uses ALL_PROXY as fallback, follows redirects, and respects NO_PROXY", async () => {
    let proxyHits = 0;
    const proxyPort = await listen(createServer((_req, res) => { proxyHits++; res.end("via proxy"); }));
    expect(await fetchSubscriptionText("http://subscription.invalid/sub", {
      env: environment({ ALL_PROXY: `http://127.0.0.1:${proxyPort}` })
    })).toBe("via proxy");
    const originPort = await listen(createServer((req, res) => {
      if (req.url === "/redirect") { res.writeHead(302, { Location: "/valid" }); res.end(); }
      else res.end(content);
    }));
    expect(await fetchSubscriptionText(`http://127.0.0.1:${originPort}/redirect`, {
      env: environment({ HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: "127.0.0.1" })
    })).toBe(content);
    expect(proxyHits).toBe(1);
  });

  it.each([401, 403, 404, 407, 429, 500])("reports HTTP %i without returning the secret response body or URL", async (status) => {
    const port = await listen(createServer((_req, res) => { res.writeHead(status); res.end("private-token"); }));
    const result = await fetchSubscriptionText(`http://127.0.0.1:${port}/sub?token=private-token`, { env: environment() }).catch((error: Error) => error.message);
    expect(result).toContain(`HTTP ${status}`);
    expect(result).not.toContain("private-token");
  });

  it("times out while reading a stalled response body", async () => {
    const port = await listen(createServer((_req, res) => { res.writeHead(200, { "Content-Length": 100 }); res.write("partial"); }));
    await expect(fetchSubscriptionText(`http://127.0.0.1:${port}`, { env: environment(), timeoutMs: 150 })).rejects.toThrow("请求超时");
  });

  it("rejects oversized downloads", async () => {
    const port = await listen(createServer((_req, res) => { res.writeHead(200, { "Content-Length": 11 * 1024 * 1024 }); res.end(); }));
    await expect(fetchSubscriptionText(`http://127.0.0.1:${port}`, { env: environment() })).rejects.toThrow("10 MiB");
  });

  it("rejects non-HTTP URLs", async () => {
    await expect(fetchSubscriptionText("file:///private-file")).rejects.toThrow("HTTP 或 HTTPS");
  });

  it("does not fall back to a direct connection when the configured proxy fails", async () => {
    let directHits = 0;
    const origin = await listen(createServer((_req, res) => { directHits++; res.end(content); }));
    const unavailable = createServer();
    unavailable.listen(0, "127.0.0.1");
    await once(unavailable, "listening");
    const port = (unavailable.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => unavailable.close(() => resolve()));
    await expect(fetchSubscriptionText(`http://127.0.0.1:${origin}`, {
      env: environment({ HTTP_PROXY: `http://127.0.0.1:${port}` }), timeoutMs: 1000
    })).rejects.toThrow(/无法连接|请求超时/);
    expect(directHits).toBe(0);
  });

  it("supports SOCKS5h with remote DNS through ALL_PROXY", async () => {
    let destination = "";
    const sockets = new Set<net.Socket>();
    const proxy = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let buffered = Buffer.alloc(0);
      let stage = 0;
      socket.on("data", (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (stage === 0) {
          if (buffered.length < 2 + (buffered[1] ?? 0)) return;
          buffered = buffered.subarray(2 + buffered[1]!);
          socket.write(Buffer.from([5, 0]));
          stage = 1;
        }
        if (stage === 1) {
          if (buffered.length < 5) return;
          if (buffered[3] !== 3) { socket.destroy(); return; }
          const length = buffered[4]!;
          if (buffered.length < 7 + length) return;
          destination = buffered.subarray(5, 5 + length).toString();
          buffered = buffered.subarray(7 + length);
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
          stage = 2;
        }
        if (stage === 2 && buffered.includes("\r\n\r\n")) {
          socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(content)}\r\nConnection: close\r\n\r\n${content}`);
        }
      });
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const port = (proxy.address() as net.AddressInfo).port;
    try {
      expect(await fetchSubscriptionText("http://subscription.invalid/sub", {
        env: environment({ ALL_PROXY: `socks5h://127.0.0.1:${port}` }), timeoutMs: 2000
      })).toBe(content);
      expect(destination).toBe("subscription.invalid");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});
