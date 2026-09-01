# CI/CD 与镜像发布

项目使用 GitHub Actions 自动检查代码并发布容器镜像到 GHCR。

## 工作流

- `CI`：在 `main` 推送和 PR 上运行 `pnpm check`、`pnpm test`、`pnpm build`。
- `Docker Image`：在 `main` 推送、版本 tag 和手动触发时构建镜像并推送到 GHCR。

## 镜像

默认镜像：

```text
ghcr.io/dsyzayn/mihomo-hive:latest
```

镜像内置 Mihomo binary，Dockerfile 会根据 BuildKit 的 `TARGETOS/TARGETARCH` 下载对应 Linux binary。`linux/amd64` 使用 Mihomo 的 `amd64-compatible` 包，避免老 CPU 不支持 x86-64-v3 导致无法启动。

支持平台：

- `linux/amd64`
- `linux/arm64`

## 运行时约定

容器启动时会通过 `scripts/container-entrypoint.sh` 首次生成 `/data/hive.config.json`。容器镜像不包含运行时数据；订阅 URL、数据库、Mihomo 配置和导出文件应保存在外部挂载的数据目录中。
