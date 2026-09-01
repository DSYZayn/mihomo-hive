import { expect, test } from "@playwright/test";

test.describe("Mihomo Hive 首次访问 + 主导航", () => {
  test("首次访问设密码、登录后 2 个 workspace tab 可切换", async ({ page }) => {
    await page.goto("/");

    // 首次访问应当展示"设置访问密码"
    await expect(page.getByRole("heading", { name: "设置访问密码" })).toBeVisible();

    const passwordFields = page.locator("input[type='password']");
    await passwordFields.nth(0).fill("e2e-test-pass-1234");
    await passwordFields.nth(1).fill("e2e-test-pass-1234");
    await page.getByRole("button", { name: "设置并进入" }).click();

    // 进入 dashboard，精简后的 2 个 workspace tab 都出现
    const nav = page.getByRole("navigation", { name: "工作区" });
    await expect(nav.getByRole("tab", { name: "节点池" })).toBeVisible();
    await expect(nav.getByRole("tab", { name: "设置与工具" })).toBeVisible();

    // 默认在节点池：能看到导入订阅表单 + 节点池操作栏
    await expect(page.getByRole("heading", { name: "导入订阅" })).toBeVisible();
    await expect(page.getByRole("button", { name: "仅保存订阅源" })).toBeVisible();
    await expect(page.getByRole("button", { name: "拉取并预览" })).toBeVisible();
    // NodeToolbar 高频按钮（左→右工作流：分配端口 → 测试 → 启用调度）
    await expect(page.getByRole("button", { name: "分配端口" })).toBeVisible();
    await expect(page.getByRole("button", { name: "测试所选" })).toBeVisible();
    await expect(page.getByRole("button", { name: "测试全部" })).toBeVisible();
    await expect(page.getByRole("button", { name: "启用调度" })).toBeVisible();

    // 切到设置与工具：连接配置 + 运维工具 + 导出节点集中地（P5-AK 重构）
    await nav.getByRole("tab", { name: "设置与工具" }).click();
    await expect(page.getByRole("heading", { name: "Sub2API 连接" })).toBeVisible();

    // 回到节点池
    await nav.getByRole("tab", { name: "节点池" }).click();
    await expect(page.getByRole("heading", { name: "导入订阅" })).toBeVisible();
  });

  test("点击拉取并预览需要先填 URL", async ({ page }) => {
    await page.goto("/");
    // 已存在密码，进入登录
    await expect(page.getByRole("heading", { name: "登录 Mihomo Hive" })).toBeVisible();
    await page.locator("input[type='password']").fill("e2e-test-pass-1234");
    await page.getByRole("button", { name: "登录" }).click();

    // 拉取并预览按钮默认 disabled
    const previewButton = page.getByRole("button", { name: "拉取并预览" });
    await expect(previewButton).toBeDisabled();
    const saveButton = page.getByRole("button", { name: "仅保存订阅源" });
    await expect(saveButton).toBeDisabled();
  });
});
