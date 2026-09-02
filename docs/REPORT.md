# 交付记录

> 当前应用版本：`1.0.7`。
> 本文件仅记录当前项目状态与历史文档入口；旧交付报告不再作为当前实现依据。

## 当前状态

- 目标平台：Debian 13 / amd64，发布格式为 `.deb`
- 应用界面：Electron 启动本地 dsh Web 引擎后加载官方 Web UI
- 桌面能力：首启与故障回退页、凭证安全存储、托盘、自动更新、提醒、记忆插件和归档会话查看
- 发布：GitHub Actions 构建 `.deb`、`latest-linux.yml` 与 blockmap，并以 `v<package.json version>` 创建 Release
- 当前本地插件：`harness-memory`

## 验证基线

提交代码前至少执行：

```bash
pnpm typecheck
pnpm test
pnpm build
```

打包验证执行：

```bash
pnpm dist
node scripts/verify-deb.mjs
```

CI 会在 Debian 13 容器中构建，并检查 `.deb` 控制信息、更新元数据和包完整性。上游 dsh 版本同步由发布工作流在定时或手动触发时处理。

## 历史记录

`docs/history/REPORT-001.md` 至 `REPORT-017.md` 保存早期迭代记录。原 `001-030b` 汇总内容对应旧实现、旧平台假设和当时的验证结果，已由 Git 历史保留，不再重复维护。

查看当前代码结构、运行方式和约定，请阅读仓库根目录的 [README.md](../README.md)。
