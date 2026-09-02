# 官方 Web UI 迁移说明

> 状态：核心迁移已实施；本文保留当前架构边界，不再维护已完成的阶段计划和旧版工作量估算。

## 当前实现

DSH Desktop 不再以仓库内 React 聊天界面作为常驻主界面。应用启动后由 `DshManager` 运行：

```text
dsh web --host 127.0.0.1 --port 0
```

引擎就绪时，`electron/main.ts` 调用 `loadEngineUI()`，将 `BrowserWindow` 导航到随机回环端口提供的官方 dsh Web UI。这样官方 UI 与 dsh API 同源，不引入 iframe 或跨源请求问题。

本仓库的 Vite React 页面仍保留，用于：

- 引擎启动期间的占位与故障回退
- 首次启动向导
- 需要 Electron 主进程配合的桌面管理界面

## 桌面桥接

`electron/preload.ts` 为官方页面暴露两套受限 API：

- `window.harness`：稳定的业务 IPC 契约，定义于 `shared/types.ts`
- `window.__desktop__`：官方页面需要的壳层能力，例如引擎端口、版本、通知、归档会话和菜单事件

所有新增能力仍遵循以下边界：

```text
shared/types.ts -> electron/preload.ts -> electron/ipc.ts -> adapter 或主进程服务
```

不要让 renderer 或官方 UI 直接依赖 dsh 原始 RPC / WebSocket 数据格式。

## 端口漂移与回退

dsh 引擎使用随机端口。`DshManager` 在引擎异常退出后会重启，并重新绑定事件订阅；`main.ts` 监听状态变化后重新加载新的官方 UI 地址。引擎未就绪或加载失败时，窗口保留本地回退页面，避免白屏。

## 官方 UI 注入

当前官方页面的桌面扩展由预加载脚本注入：

- 品牌标识与首次会话 hero 替换
- 归档会话入口与只读查看器

这些注入依赖上游 UI 的运行时 DOM。升级 `@deepseek-ai/dsh` 后，应手动验证页面渲染、注入位置、菜单事件和归档操作；若官方 DOM 结构变化，优先缩小或移除脆弱的注入逻辑，而非绕过安全边界。

## 未采用的旧方案

本仓库不维护 iframe 方案，也不维护旧版“为每个桌面功能创建官方客户端模块”的阶段计划。历史推演和验证记录由 Git 历史及 `docs/history/` 保存；当前实现以代码、[README.md](../README.md) 和 [CLAUDE.md](../CLAUDE.md) 为准。
