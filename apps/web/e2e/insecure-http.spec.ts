import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";

// localhost is a secure context even over HTTP. Use a non-loopback origin,
// resolved locally by the browser, to exercise an actual public-HTTP context.
test.use({
  launchOptions: {
    args: ["--host-resolver-rules=MAP hive-http.test 127.0.0.1", "--no-proxy-server"]
  }
});

test.describe("公网 HTTP 下的操作反馈", () => {
  let source: Server;
  let subscriptionUrl: string;

  test.beforeAll(async () => {
    source = createServer((req, res) => {
      res.end(req.url === "/invalid"
        ? "<html><body>Subscription expired</body></html>"
        : "proxies:\n  - name: HTTP-context-test\n    type: socks5\n    server: http-context.example\n    port: 1080\n");
    });
    source.listen(0, "127.0.0.1");
    await once(source, "listening");
    subscriptionUrl = `http://127.0.0.1:${(source.address() as AddressInfo).port}/sub`;
  });

  test.afterAll(async () => {
    source.closeAllConnections();
    await new Promise<void>((resolve) => source.close(() => resolve()));
  });

  test("缺少 randomUUID 时仍可预览、导入，成功和失败提示均正常", async ({ page, baseURL }, testInfo) => {
    const publicOrigin = new URL(baseURL!);
    publicOrigin.hostname = "hive-http.test";
    const password = "e2e-test-pass-1234";
    const status = await (await page.request.get("/api/auth/status")).json();
    const login = await page.request.post(status.configured ? "/api/auth/login" : "/api/auth/setup", { data: { password } });
    expect(login.ok()).toBe(true);
    const cookies = await page.context().cookies(baseURL!);
    await page.context().addCookies(cookies.map((cookie) => ({ ...cookie, domain: publicOrigin.hostname })));

    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(publicOrigin.toString());
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
    expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");

    const panel = page.locator(".node-pool-panel");
    await panel.getByLabel("名称", { exact: true }).fill("HTTP context test");
    await panel.getByLabel("订阅 URL", { exact: true }).fill(subscriptionUrl);
    await panel.getByRole("button", { name: "拉取并预览", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const previewToasts = page.locator(".toast").filter({ hasText: "订阅预览完成" });
    await expect(dialog).toContainText("共解析 1 个节点");
    await expect(previewToasts).toHaveCount(1);
    await expect(dialog.getByRole("alert")).toHaveCount(0);

    await dialog.getByRole("button", { name: "用当前关键词重新预览" }).click();
    await expect(previewToasts).toHaveCount(2);
    await previewToasts.first().getByRole("button").click();
    await expect(previewToasts).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: "重新导入这些节点" })).toBeEnabled();
    await dialog.getByRole("button", { name: "重新导入这些节点" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".toast").filter({ hasText: "节点已重新导入" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "HTTP-context-test", exact: true })).toBeVisible();

    await panel.getByLabel("订阅 URL", { exact: true }).fill(subscriptionUrl.replace("/sub", "/invalid"));
    await panel.getByRole("button", { name: "拉取并预览", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("返回了网页");
    await expect(page.locator(".toast-danger")).toContainText("订阅预览失败");
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("insecure-http-feedback.png"), fullPage: true });
  });
});
