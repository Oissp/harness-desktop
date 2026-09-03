# 打包优化分析

## 当前状态

- **node_modules 总大小**：919 MB
- **主要体积占用**：
  - `electron`（devDep）：296 MB
  - `@deepseek-ai/*` 作用域：35 MB（含核心引擎 `dsh` 等 224 个包）
  - `typescript`（devDep）：23 MB
  - 非目标平台 prebuild：~24 MB（darwin-arm64）

## 已实施的优化

### 1. 排除 devDependencies（after-pack.mjs）

`after-pack.mjs` 已实现复制时排除所有 devDependencies：

```javascript
// 从 package.json 读取 devDeps 并在复制时过滤
const devDeps = loadDevDeps(projectRoot)
if (devDeps.has(name)) return true
```

**效果**：排除 ~320 MB（electron 296 MB + typescript 23 MB + 其他构建工具）

### 2. 排除非目标平台 prebuild（after-pack.mjs:106-116）

已实现识别和排除非目标平台的原生模块：

```javascript
function isNonTargetPrebuild(pkgName, targetPlatform, targetArch) {
  const m = pkgName.match(/-(linux|win32|darwin|freebsd|sunos)-(x64|arm64|arm32|ia32|armv7l)$/)
  if (!m) return false
  const [, plat, arch] = m
  return plat !== targetPlatform || arch !== targetArch
}
```

**当前本机环境的非目标包**（darwin-arm64，打包 linux-x64 时会被排除）：
- `@img/sharp-libvips-darwin-arm64`：17 MB
- `@vscode/ripgrep-darwin-arm64`：4.3 MB
- `@rollup/rollup-darwin-arm64`：1.7 MB
- `@koromix/koffi-darwin-arm64`：1.2 MB

**效果**：~24 MB（本机环境；CI 构建时也会排除其他平台）

### 3. 确认默认压缩为 xz（electron-builder.yml:62-65）

压缩保持默认的 xz，**未添加任何 deb 压缩配置**：

```yaml
# deb 压缩：保持默认 xz（fpm 1.9.3 只支持 gz|bzip2|xz）。实测 623MB 原始数据，
# xz -3 在三个支持的压缩里体积最小（~138MB）且最快（CI ~2min）；gzip -9 更慢更大
# （~185MB）、bzip2 -9 也更慢更大（~158MB）。故不做覆盖，不要为此加 deb 配置。
```

上述 yaml 仅为注释，说明为何不加配置——xz 是默认行为，不需要（也不应）显式声明。

**效果**：623 MB 原始数据 → ~138 MB .deb 包

### 4. 禁用 asar（electron-builder.yml:27）

```yaml
# 不使用 asar：dsh profile 初始化会为安装包内的依赖创建符号链接，
# 需要真实文件路径（asar 内的符号链接目标不可靠）。
asar: false
```

**权衡**：`asar: true` 可减少 ~10-15% 体积，但会破坏 dsh 的符号链接机制，无法启用。

## 进一步优化空间

### 高优先级：可立即实施

#### 1. 排除构建工具二进制（已部分实施）

`after-pack.mjs:122` 已排除部分构建工具：

```javascript
const buildTools = new Set(['app-builder-bin', '7zip-bin', 'esbuild', 'electron-builder-binaries'])
```

**建议**：检查 `node_modules` 中是否还有其他构建时工具泄入，例如：
- `@swc/core-*`（如果使用）
- `@esbuild/*`（esbuild 的平台包）
- 各种 linter / formatter 的二进制

**验证方法**：
```bash
pnpm dist
node scripts/verify-deb.mjs
# 检查警告输出中的非目标 prebuild
```

#### 2. 审查 production dependencies

当前 production deps 体积合理：
- `@deepseek-ai/*` 作用域：35 MB（含核心引擎 `dsh`，必需）
- `electron-updater`：1.3 MB
- `react-dom`：4.4 MB
- `yaml`：1.2 MB
- `react`：368 KB

**建议**：定期检查 `@deepseek-ai/dsh` 的传递依赖：
```bash
pnpm list --prod --depth=3 | grep -E "^\S" | wc -l  # 统计包数量
```

### 中优先级：需要测试验证

#### 3. 拆分 React 构建（Vite bundle 分析）

fallback UI（首启向导、故障页）使用 React，但正式界面由 dsh Web 提供。

**当前状态**：`react-dom` 4.4 MB 全部打包进 `dist/`

**优化方向**：
- 检查 Vite 构建产物中 React 的实际体积（已压缩）
- 评估是否可用轻量级替代（Preact：3KB vs React：40KB gzipped）
- 或者保持现状（fallback UI 使用频率低，React 熟悉度高）

**验证方法**：
```bash
pnpm build:renderer
du -sh dist/assets/*.js  # 检查 bundle 大小
```

#### 4. Tree-shaking 审查

**检查点**：
- `electron/` 主进程代码是否有未使用的大型依赖
- `adapter/` 的 JSON-RPC 实现是否引入冗余库
- `shared/` 类型定义是否意外拉入运行时代码

**工具**：
```bash
pnpm build:electron
# 检查 dist-electron 体积
du -sh dist-electron/
```

### 低优先级：长期优化

#### 5. dsh 引擎依赖优化（上游）

`@deepseek-ai/*` 作用域 35 MB 含 224 个包，需要完整依赖闭包。

**可能方向**（需上游支持）：
- dsh 提供 "headless" 模式（去除 Web UI 资源）
- 减少传递依赖数量
- 使用 ESM + tree-shaking

**当前不可行**：项目对上游无控制权，只能接受现状。

#### 6. 动态依赖下载（破坏性变更）

**方案**：首次启动时从 CDN 下载 dsh 引擎，而非打包进 `.deb`

**优点**：
- `.deb` 体积降至 ~50 MB
- 引擎更新无需重新发布客户端

**缺点**：
- 破坏离线安装能力
- 增加首启失败风险（网络、CDN 可用性）
- 与当前 "内置引擎" 的产品定位冲突

**结论**：不推荐，除非产品定位改变。

## 压缩效果预估

假设实施上述优化：

| 项目 | 当前 | 优化后 | 节省 |
|------|------|--------|------|
| 原始数据 | ~623 MB | ~550 MB | ~73 MB |
| .deb 包（xz -3） | ~138 MB | ~122 MB | ~16 MB |

**主要节省来源**：
- 排除遗漏的构建工具：~20 MB
- React 优化（如果采用 Preact）：~3 MB
- Tree-shaking 清理：~10 MB

**实际效果**：需逐项实施并测试验证。

## 验证清单

每次优化后执行：

```bash
# 1. 构建并检查体积
pnpm dist
ls -lh out/*.deb

# 2. 运行完整性校验
node scripts/verify-deb.mjs

# 3. 本地安装测试
sudo apt install ./out/dsh-desktop_*.deb
dsh-desktop  # 验证启动、首启向导、引擎初始化

# 4. 检查运行时日志（userData/logs/，Linux 下为 ~/.config/dsh-desktop/logs/）
tail -f ~/.config/dsh-desktop/logs/dsh-*.log
```

## 结论

项目的打包优化已达到较高水平：

- ✅ devDependencies 排除（~320 MB）
- ✅ 非目标平台 prebuild 排除（~24 MB）
- ✅ 默认压缩即 xz（~55% 体积缩减，无需配置）
- ✅ 完整性校验脚本（防止优化引入 bug）

**进一步优化空间有限**（~15-20 MB），且需要权衡：
- 功能完整性（React vs Preact）
- 产品定位（内置引擎 vs 动态下载）
- 维护成本（复杂 tree-shaking vs 简单全量复制）

**建议**：保持现状，定期审查新依赖，避免体积回归。
