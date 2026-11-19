import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import net from "node:net";
import { once } from "node:events";
import type { ProxyNode } from "@mihomo-hive/schemas";

test("选择已有节点拉取订阅，保存后可修改并重新拉取", async ({ page }, testInfo) => {
  const seedContent = "proxies:\n  - name: Fetch-proxy-test\n    type: socks5\n    server: proxy.example.com\n    port: 1080\n";
  const fetchedContent = seedContent.replace("Fetch-proxy-test", "Fetched-through-proxy").replace("proxy.example.com", "target.example.com");
  const source = createServer((_req, res) => res.end(seedContent));
  const sockets = new Set<net.Socket>();
  let downloads = 0;
  const proxy = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let stage = 0;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0) {
        if (buffer.length < 2 + (buffer[1] ?? 0)) return;
        buffer = buffer.subarray(2 + buffer[1]!);
        socket.write(Buffer.from([5, 0]));
        stage = 1;
      }
      if (stage === 1) {
        if (buffer.length < 5) return;
        if (buffer[3] !== 3) { socket.destroy(); return; }
        const length = buffer[4]!;
        if (buffer.length < 7 + length) return;
        buffer = buffer.subarray(7 + length);
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        stage = 2;
      }
      if (stage === 2 && buffer.includes("\r\n\r\n")) {
        stage = 3;
        downloads++;
        socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(fetchedContent)}\r\nConnection: close\r\n\r\n${fetchedContent}`);
      }
    });
  });
  source.listen(0, "127.0.0.1");
  await once(source, "listening");
  try {
    const status = await (await page.request.get("/api/auth/status")).json();
    await page.request.post(status.configured ? "/api/auth/login" : "/api/auth/setup", { data: { password: "e2e-test-pass-1234" } });
    const seedUrl = `http://127.0.0.1:${(source.address() as net.AddressInfo).port}/sub`;
    expect((await page.request.post("/trpc/subscriptions.applyImport", { data: { name: "proxy-seed", url: seedUrl } })).ok()).toBe(true);
    expect((await page.request.post("/trpc/nodes.assignPorts", { data: {} })).ok()).toBe(true);
    const nodes = (await (await page.request.get("/trpc/nodes.list")).json()).result.data as ProxyNode[];
    const node = nodes.find((item) => item.name === "Fetch-proxy-test")!;
    expect(node.assignedPort).toBeTruthy();
    proxy.listen(node.assignedPort!, "127.0.0.1");
    await once(proxy, "listening");

    await page.goto("/");
    const panel = page.locator(".node-pool-panel");
    await panel.getByLabel("名称", { exact: true }).fill("Proxied subscription");
    await panel.getByLabel("订阅 URL", { exact: true }).fill("http://subscription.invalid/sub");
    await panel.getByRole("combobox", { name: "拉取代理", exact: true }).selectOption(node.hash);
    await panel.getByRole("button", { name: "拉取并预览", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Fetched-through-proxy");
    await dialog.getByRole("button", { name: "用当前关键词重新预览" }).click();
    await expect.poll(() => downloads).toBe(2);
    await dialog.getByRole("button", { name: "重新导入这些节点" }).click();
    await expect(dialog).toHaveCount(0);
    const savedProxy = panel.getByRole("combobox", { name: "Proxied subscription · 拉取代理", exact: true });
    await expect(savedProxy).toHaveValue(node.hash);
    await page.reload();
    await expect(savedProxy).toHaveValue(node.hash);
    const card = panel.locator(".subscription-card").filter({ hasText: "Proxied subscription" });
    await card.getByRole("button", { name: "重新导入", exact: true }).click();
    await expect(dialog).toContainText("Fetched-through-proxy");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await savedProxy.selectOption("");
    await expect(savedProxy).toHaveValue("");
    await page.reload();
    await expect(savedProxy).toHaveValue("");
    await savedProxy.selectOption(node.hash);
    await expect(savedProxy).toHaveValue(node.hash);
    await expect(savedProxy).toBeEnabled();
    await savedProxy.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("subscription-proxy.png"), fullPage: true });
  } finally {
    source.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => source.close(() => resolve()));
    if (proxy.listening) await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});
