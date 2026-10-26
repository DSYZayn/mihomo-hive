import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { proxyNodeSchema, runtimeConfigSchema } from "@mihomo-hive/schemas";
import { renderMihomoConfig } from "./mihomo-render.js";
import { measureProxyTcpLatency, testProxyTarget } from "./node-test.js";

// Opt in with a real Mihomo binary; all requests remain on loopback.
describe.skipIf(!process.env.HIVE_TEST_MIHOMO_BIN)("Mihomo proxy authentication", () => {
  it("rejects missing/wrong credentials on every listener and accepts the shared credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hive-proxy-auth-"));
    const target = createServer((_req, res) => { res.writeHead(200); res.end("ok"); });
    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    const targetPort = (target.address() as net.AddressInfo).port;
    const ports = [await freePort(), await freePort()];
    const auth = { username: "hive@test", password: "p@ss:word#% /?" };
    const nodes = ports.map((port) => proxyNodeSchema.parse({
      hash: `local-${port}`, sourceId: "test", name: `local-${port}`, originalName: `local-${port}`,
      type: "direct", raw: { type: "direct" }, assignedPort: port,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
    }));
    const config = runtimeConfigSchema.parse({
      listenHost: "0.0.0.0", proxyAuth: auth, externalController: "127.0.0.1:0"
    });
    const configPath = join(directory, "mihomo.yaml");
    await writeFile(configPath, renderMihomoConfig(nodes, config).yaml);
    const child = spawn(process.env.HIVE_TEST_MIHOMO_BIN!, ["-d", directory, "-f", configPath], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    });
    const closed = once(child, "close");
    let output = "";
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-4000); });
    child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-4000); });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) throw new Error(`Mihomo exited: ${output}`);
        if ((await measureProxyTcpLatency({ host: "127.0.0.1", port: ports[0]!, timeoutMs: 100 })).error === null) {
          ready = true;
          break;
        }
        await delay(50);
      }
      expect(ready, output).toBe(true);
      for (const port of ports) {
        const request = {
          host: "127.0.0.1", port, timeoutMs: 3000,
          target: { id: "loopback", name: "loopback", url: `http://127.0.0.1:${targetPort}`, expectedStatuses: [200] }
        };
        expect((await testProxyTarget(request)).ok).toBe(false);
        expect((await testProxyTarget({ ...request, auth: { ...auth, password: "wrong" } })).ok).toBe(false);
        expect(await testProxyTarget({ ...request, auth })).toMatchObject({ ok: true, httpStatus: 200 });
      }
    } finally {
      child.kill();
      await closed;
      await new Promise<void>((resolve) => target.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
