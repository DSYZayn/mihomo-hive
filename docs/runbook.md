# 运维手册

公开部署建议直接使用预构建镜像，运行数据挂载到独立目录。

## 启动服务

```bash
docker compose up -d
```

服务启动后会自动：
- 创建运行配置 `/data/hive.config.json`
- 启动 Mihomo（基于上次发布的 yaml；首次启动尚无 yaml 时跳过）
- 启动节点维护器：按订阅策略刷新、合并重复节点、验活已分配节点，并幂等同步健康节点到 Sub2API；不会改动账号代理绑定

Web UI 默认监听 `0.0.0.0:9990`：

```text
http://127.0.0.1:9990
```

`HIVE_HOST` / `HIVE_PORT` 通过环境变量改。首次访问要求设置访问密码。

## 访问密码

密码哈希保存在 SQLite 数据库中。忘记密码时通过容器内 CLI 重置：

```bash
docker exec mihomo-hive node apps/cli/dist/index.js auth reset-password --password "new-strong-password"
```

推荐从 stdin 传入避免落入 shell 历史：

```bash
printf '%s' 'new-strong-password' | docker exec -i mihomo-hive node apps/cli/dist/index.js auth reset-password --password-stdin
```

重置密码会撤销所有已登录会话。

---

## Web UI 工作流

Web UI 顶部 2 个 tab：节点池 / 设置与工具。所有写操作完成后会自动重新读取服务端状态，无需手动刷新网页。

### 仅订阅转换（不用 Sub2API）

节点池 tab 走 3 步：

1. **左栏添加订阅源** → 拉取 + 预览 → 应用导入。新节点出现在右侧节点表
2. 在节点表勾选要保留的节点，点工具栏 **【分配端口】**：给所选节点分端口 + 渲染 Mihomo + reload
3. 点 **【测试所选】** 或 **【测试全部】**：
   - 代理延迟列：普通节点显示直连握手时间，链式节点显示完整链路到业务目标的端到端时间
   - 目标延迟列显示 L2（OpenAI / Claude 端到端，秒数 + 颜色编码）

通过测试的节点已在 `127.0.0.1:{port}` 提供 listener，可以直接接到上游脚本。如需打包 JSON 给其他系统使用，切到**设置与工具**。

### 启用 Sub2API 节点同步

在上面 3 步基础上：

4. 切到**设置与工具**，配置 Sub2API 连接（baseUrl + adminApiKey + 托管前缀）
5. 回到节点池，将节点设为 `schedulable` 并完成验活；后台会自动把健康节点幂等推送到 Sub2API 并回填 `proxy_id`
6. 后台永远不会调用账号批量换代理接口，因此已有账号的出口不会因为节点刷新而漂移

### 节点池工具栏低频操作（`⋯` dropdown）

| 分组 | 项 | 说明 |
|---|---|---|
| 诊断 | 重建 Mihomo | yaml 损坏 / 进程挂掉时强制重渲染 + reload。不动端口、不改 lifecycle、不推 Sub2API |
| 生命周期（所选） | 暂停 / 冷却 / 退役 / 删除 | lifecycle 状态过渡 |
| 筛选 | 选择 status=active 的节点 | 快速勾选可用节点 |

---

## CLI 自动化

CLI 与 Web UI 使用同一套数据库和核心逻辑。

### 订阅与节点

```bash
hive sub add --name demo --url "https://example.com/sub"
hive sub fetch
hive sub list                       # 只输出订阅摘要，不打印订阅正文
hive nodes import
hive nodes list
```

### 端口与 Mihomo

```bash
hive ports assign --range 10001-10300
hive mihomo render
hive mihomo start                   # 首次启动；后续改动用 reload
hive mihomo reload
hive mihomo status
```

端口分配基于节点 hash 尽量保持稳定。订阅更新后同一节点会优先复用原端口。

### 测试

```bash
hive nodes test --targets openai,claude --timeout-ms 15000 --concurrency 8
```

普通节点先测直连代理握手，再测每个业务目标；链式节点不绕过中间跳，所有健康结果都通过 Mihomo listener 走完整链路到目标 URL。

内置测试目标：

| ID | URL | 期望状态 |
|---|---|---|
| `ip` | `https://api.ipify.org` | 200 |
| `openai` | `https://api.openai.com/v1/models` | 401（无 token） |
| `claude` | `https://api.anthropic.com/v1/messages` | 405（GET 请求） |

测试通过的节点 status 标 `active`，失败标 `failed`。CLI 输出包含 L1 延迟和每个目标的 status code。

### 导出

```bash
hive export sub2api --host 127.0.0.1 --output /data/generated/sub2api-proxies.json
```

导出文件只包含 `status=active` 且已分配端口的节点。Web UI 中可先筛选/勾选目标节点再下载或写出。

---

## 开发模式

```bash
pnpm install
pnpm check
pnpm test
pnpm build
pnpm --filter @mihomo-hive/server dev
```

更多技术文档：

- [架构总览](architecture.md)
- [数据模型](data-model.md)
- [ADR 0003 声明式编排](decisions/0003-declarative-orchestration.md)
- [ADR 0004 账号编排](decisions/0004-account-fleet-orchestrator.md)
- [CI/CD](cicd.md)
