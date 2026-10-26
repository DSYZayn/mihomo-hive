import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";

test.describe("订阅失败提示", () => {
  let source: Server;
  let url: string;
  let valid = false;

  test.beforeAll(async () => {
    source = createServer((_req, res) => {
      res.end(valid
        ? "proxies:\n  - name: Test\n    type: socks5\n    server: example.com\n    port: 1080\n"
        : "<html><body>Subscription expired</body></html>");
    });
    source.listen(0, "127.0.0.1");
    await once(source, "listening");
    url = `http://127.0.0.1:${(source.address() as AddressInfo).port}/sub`;
  });

  test.afterAll(async () => {
    source.closeAllConnections();
    await new Promise<void>((resolve) => source.close(() => resolve()));
  });

  test("错误在表单中保留，重试成功后清除，导入失败也显示在弹窗内", async ({ page }, testInfo) => {
    const password = "e2e-test-pass-1234";
    const status = await (await page.request.get("/api/auth/status")).json();
    await page.request.post(status.configured ? "/api/auth/login" : "/api/auth/setup", { data: { password } });
    await page.goto("/");
    const panel = page.locator(".node-pool-panel");
    await panel.getByLabel("名称", { exact: true }).fill("Subscription test");
    await panel.getByLabel("订阅 URL", { exact: true }).fill(url);
    await panel.getByRole("button", { name: "拉取并预览", exact: true }).click();
    const error = panel.getByRole("alert");
    await expect(error).toContainText("返回了网页");
    // Toasts expire after five seconds; the inline diagnostic must remain visible.
    await page.waitForTimeout(5200);
    await expect(error).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("subscription-fetch-error.png"), fullPage: true });

    valid = true;
    await panel.getByRole("button", { name: "拉取并预览", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("共解析 1 个节点");
    await expect(panel.getByRole("alert")).toHaveCount(0);
    valid = false;
    await dialog.getByRole("button", { name: "重新导入这些节点" }).click();
    await expect(dialog.getByRole("alert")).toContainText("返回了网页");
    await expect(dialog.getByRole("button", { name: "重新导入这些节点" })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("subscription-import-error.png"), fullPage: true });
  });
});
