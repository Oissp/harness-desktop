# Debian 安装包体积说明

> 目标：在不破坏 dsh 引擎和原生依赖加载的前提下，控制 Debian amd64 `.deb` 的体积。

## 当前打包方式

发布目标仅为 Debian 13 / amd64。`pnpm dist` 会构建 renderer 和 Electron 主进程，再通过 electron-builder 输出 `.deb` 到 `out/`。

dsh 依赖闭包不能交给 electron-builder 的默认依赖收集：在 pnpm 环境下，它可能遗漏 `@deepseek-ai/*` 的传递依赖，导致打包后的引擎无法启动。因此 `scripts/after-pack.mjs` 会：

1. 复制扁平化 `node_modules` 中的运行时依赖
2. 排除 `package.json` 中列出的开发依赖和构建工具
3. 排除非目标平台/架构的原生预构建包
4. 验证目标平台的 koffi 原生二进制实际存在于产物

## 必须保留的内容

- `@deepseek-ai/*` 及其运行时依赖闭包
- `node-pty`、`koffi` 等原生模块
- `vendor/node/` 中由构建流程准备的独立 Node 运行时
- `plugins/` 和 dsh Web profile 初始化所需文件

`asar: false` 同样是必需设置：profile 初始化会创建符号链接，需要真实文件系统路径。

## 不应进入产物的内容

`after-pack.mjs` 会排除开发与构建工具，例如 Electron 开发运行时、electron-builder、TypeScript、Vite、Vitest、类型定义和打包辅助二进制。不要通过“只复制少量依赖”的方式进一步裁剪，除非已经验证 dsh 在打包产物中可以启动。

## 验证

每次修改依赖、`after-pack.mjs`、Electron 版本或打包配置后，至少执行：

```bash
pnpm test
pnpm build
pnpm dist
node scripts/verify-deb.mjs
```

CI 还会校验 `.deb` 控制信息和 `out/latest-linux.yml`。实际体积会随 `@deepseek-ai/dsh`、Electron 与原生模块版本变化；以每次构建的 `out/` 产物为准，不在文档中维护与当前发布目标无关的旧平台估算值。
