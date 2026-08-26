/**
 * postinstall 加固：确保 Electron 二进制存在（pnpm install 后自动触发）。
 *
 * 背景：CI / 新克隆 / allowBuilds 被拦截等场景下，node_modules/electron 包会
 * 存在但 dist 二进制缺失，`electron .` 直接报 "Electron failed to install correctly"。
 * 本脚本在 pnpm install 生命周期末尾检查二进制，缺失时调用 electron 自带
 * install.js 补下载（可走 ELECTRON_MIRROR 加速）。
 *
 * 用法：由 package.json `postinstall` 触发（不接受参数，幂等）。
 * 失败不阻塞 install（warn + exit 0），避免把干净的项目装挂。
 */
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')
const electronDir = join(projectRoot, 'node_modules', 'electron')

/** 各平台的二进制相对路径（相对 node_modules/electron/dist/）。 */
function binaryPath(platform) {
  if (platform === 'win32') return ['electron.exe']
  if (platform === 'darwin') return ['Electron.app', 'Contents', 'MacOS', 'Electron']
  return ['electron']
}

function main() {
  if (!existsSync(electronDir)) {
    // 依赖未安装（dev 建目录等场景跳过）
    console.log('[ensure-electron] node_modules/electron 不存在，跳过')
    return
  }
  const rel = binaryPath(process.platform)
  const bin = join(electronDir, 'dist', ...rel)
  const distDir = join(electronDir, 'dist')
  if (existsSync(bin)) {
    console.log(`[ensure-electron] ✅ Electron 二进制在位（${rel.join('/')}）`)
    return
  }
  console.warn(`[ensure-electron] ⚠️ Electron 二进制缺失（${bin}），尝试补下载…`)

  const installScript = join(electronDir, 'install.js')
  const env = { ...process.env }
  // 默认走 npmmirror 加速（与 electron-builder.yml 的 electronDownload.mirror 一致）；可被外部覆盖
  env.ELECTRON_MIRROR = env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/'

  const res = spawnSync(process.execPath, [installScript], {
    cwd: electronDir,
    env,
    stdio: 'inherit',
  })
  if (res.status === 0 && existsSync(bin)) {
    console.log(`[ensure-electron] ✅ Electron 二进制补装成功（${distDir}）`)
    return
  }
  console.warn(
    '[ensure-electron] ❌ 补装失败（dist 仍缺失）。可手动执行：\n' +
      `  node ${installScript}\n` +
      '  （如需国内加速：export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/）',
  )
  // 不 exit 1：避免纯安装流程被一个可重试步骤卡死
}

try {
  main()
} catch (err) {
  console.warn('[ensure-electron] 检查异常（忽略，不阻塞 install）:', err?.message ?? err)
}