# DSH Desktop — DeepSeek Harness 桌面端

> 下载、安装、双击即聊——无需终端，无需配环境。内置 DeepSeek Harness 引擎，官方 Web UI 套上原生桌面壳。

![splash](assets/screenshots/splash.png)

![main](assets/screenshots/main.png)

## 功能

- **开箱即用**：内置 dsh 引擎，装完即聊；首启 4 步向导 3 分钟上手
- **流式聊天**：打字机输出 + 思考过程可视化
- **任务面板**：任务追踪 / 自动复盘 / 失败重试
- **Agent 进化**：记忆自动沉淀 + 同类任务自动提炼技能
- **彩色外观**：深 / 浅 / 跟随系统 × 4 种主题色，字体 / 密度可调，即时生效
- **自动更新**：启动后台检查 + 手动检查，新版本自动下载，重启即更新
- **安全**：严格 CSP / 单实例锁 / safeStorage 密钥加密 / 托盘常驻

## 安装

**Debian 13 / amd64**：[GitHub Releases](https://github.com/Oissp/harness-desktop/releases)

```bash
sudo dpkg -i dsh-desktop_*.deb
```

首启：4 步向导（欢迎 → API Key → 工作区 → 完成）。API Key 于 [platform.deepseek.com](https://platform.deepseek.com/api_keys) 获取。

> 无安装包可用开发模式：`pnpm install && pnpm dev`

## 开发

```bash
pnpm install      # Node >=22.19, pnpm >=9
pnpm dev          # vite + electron（HMR）
pnpm build        # 构建 renderer + main
pnpm test         # Vitest
pnpm typecheck    # TS 类型检查
pnpm dist         # 打包 .deb（amd64 → out/）
```

## 技术栈

- **引擎**：DeepSeek Harness `@deepseek-ai/dsh`
- **桌面壳**：Electron 43（Linux 产物钉 42.9.3）+ electron-builder
- **前端**：React 18 + TypeScript + Vite（手写 CSS，无重型 UI 库）
- **隔离层**：`adapter/` 封装 dsh API，上游变更只改 adapter，renderer 永不见 dsh 原始字段

发版由 `package.json` 的 `version` 驱动；CI 同时每日检测 dsh 上游 npm 版本并 patch-bump。仅构建 Debian 13 / amd64 `.deb`，安装包约 130–230MB。

## License

[MIT](LICENSE)

---

*非 DeepSeek 官方产品，与 DeepSeek 无附属关系；DeepSeek Harness 为 [DeepSeek AI](https://deepseek.com) 的开源项目。*
