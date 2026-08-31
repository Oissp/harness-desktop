# DSH Desktop — DeepSeek Harness 彩色桌面端

> **开箱即用的 AI 助手工作台** · The out-of-the-box desktop client for DeepSeek Harness.
> Download, install, double-click, and chat — no terminal, no environment setup.

![splash](assets/screenshots/splash.png)

![main](assets/screenshots/main.png)

## 主要功能

- **开箱即用**：内置 DeepSeek Harness 引擎，装完即聊；首启 4 步向导 3 分钟上手
- **流式聊天**：打字机输出 + 思考过程可视化，如 ChatGPT 般顺滑
- **任务面板**：任务追踪 / 自动复盘 / 失败重试，一条消息一个任务
- **Agent 进化**：记忆自动沉淀（偏好/项目约定/成功做法）+ 同类任务自动提炼技能
- **彩色外观**：深色 / 浅色 / 跟随系统主题 × DeepSeek 蓝 / 绿 / 紫 / 橙主题色，字体 / 消息密度可调，即时生效
- **自动更新**：启动后台检查 + 设置页 / 托盘一键检查，发现新版本自动下载，重启即更新
- **安全**：严格 CSP / 单实例锁 / 附件限制 / safeStorage 密钥加密
- **托盘常驻**：关闭最小化到托盘，后台持续运行

## 安装

**Debian 13 / amd64 安装包**（`.deb`）：[GitHub Releases](https://github.com/Oissp/harness-desktop/releases)

```bash
# 下载最新 .deb 后安装
sudo dpkg -i harness-desktop_*.deb
```

**首启**：运行 → 4 步向导（欢迎 → API Key → 工作区 → 完成）→ 开始对话。
API Key 于 [platform.deepseek.com](https://platform.deepseek.com/api_keys) 获取。

> 无安装包时可用开发模式运行：
> ```bash
> pnpm install
> pnpm dev
> ```

## 检查更新

应用内置 electron-updater，启动 15 秒后自动检查 GitHub Release 新版本，之后每 6 小时复检一次；也可在「设置 → 关于与更新」或托盘菜单手动「检查更新」。发现新版本时自动后台下载，下载完成后提示重启安装。

更新检测读取 Release 里的 `latest-linux.yml`（版本号 / 下载地址 / sha512）并与本地版本比对，命中新版本即下载并通过 `dpkg -i` 安装。

## 发布机制

发版由 `package.json` 的 `version` 驱动，**不依赖上游 dsh 版本号**：项目功能更新后 bump 版本号、推送 `main` 分支，CI 即构建 `.deb` + `latest-linux.yml` 并发布 `v<version>` Release。

同时保留 **dsh 上游 npm 版本检测**：每日定时检查 `@deepseek-ai/dsh` 的 npm latest，有新版则升级依赖并对应用版本号做 patch-bump（与 dsh 版本号解耦，仅标记"依赖更新发版"），随本次发版一起发布。dsh 引擎依赖的升级也视作一次发版。详见 `.github/workflows/build-debian.yml`。

## 开发

```bash
pnpm install      # 安装依赖（Node >=22.19，pnpm >=9）
pnpm dev          # 开发模式：vite + electron（HMR）
pnpm build        # 构建 renderer + main
pnpm test         # 单元测试（Vitest）
pnpm typecheck    # TS 类型检查
pnpm dist         # 打包 Debian 13 .deb（amd64，输出到 out/）
```

## 技术栈

- **引擎**：DeepSeek Harness `@deepseek-ai/dsh`
- **桌面壳**：Electron 43（Linux 产物钉 42.9.3）+ electron-builder
- **前端**：React 18 + TypeScript + Vite（手写 CSS + `--dsw-*` token，无重型 UI 库）
- **隔离层**：`adapter/` 独立封装 dsh API，上游变更只改 adapter，renderer 永不见 dsh 原始字段

## 已知限制

- **体积**：安装包约 130-230MB（内置完整 dsh 引擎 + Electron 框架）
- **平台**：仅构建 Debian 13 (trixie) / amd64 `.deb`

## License

[MIT](LICENSE)

---

*非 DeepSeek 官方产品，与 DeepSeek 无附属关系；DeepSeek Harness 为 [DeepSeek AI](https://deepseek.com) 的开源项目。*
