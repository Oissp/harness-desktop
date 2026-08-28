/**
 * scripts/fetch-node.mjs —— 获取独立 Node 运行时（vendored）。
 *
 * 借鉴 dsh_desktop 的 fetch-node.js：把真实 Node 二进制 vendor 进 vendor/node/，
 * 让 dsh 内核跑在独立 node 而非 ELECTRON_RUN_AS_NODE 下。
 * 原因：Electron 内置 Node 的 ABI 与系统 Node 不同，会拒绝预编译的原生模块
 * （koffi / node-pty 等用 optionalDependencies 分发的 prebuild）。
 *
 * 两种模式：
 *  - 本机（native）：复制 process.execPath（必须在系统 node 下运行）
 *  - 跨平台（cross）：从 nodejs.org 下载对应平台/架构的官方 build
 *
 * 用法：
 *   node scripts/fetch-node.mjs                    # 本机
 *   node scripts/fetch-node.mjs --platform=linux --arch=x64  # 跨平台
 */
import { existsSync, mkdirSync, copyFileSync, createWriteStream, rmSync, statSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')
const VENDOR_DIR = join(PROJECT_ROOT, 'vendor', 'node')

/** 解析命令行参数。 */
function parseArgs() {
  const args = { platform: process.platform, arch: process.arch }
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--(\w+)=(.+)$/)
    if (m) args[m[1]] = m[2]
  }
  return args
}

/** 下载并解压跨平台 Node。 */
async function downloadNode(platform, arch, destDir) {
  const version = process.version // e.g. v22.19.0
  const ext = platform === 'win32' ? 'zip' : 'tar.gz'
  const pkgName = `node-${version}-${platform}-${arch}`
  const url = `https://nodejs.org/dist/${version}/${pkgName}.${ext}`
  console.log(`[fetch-node] 下载: ${url}`)

  const archivePath = join(destDir, `node-download.${ext}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`)
  await pipeline(res.body, createWriteStream(archivePath))

  // 解压
  const tmpExtract = join(destDir, 'extract-tmp')
  rmSync(tmpExtract, { recursive: true, force: true })
  mkdirSync(tmpExtract, { recursive: true })
  if (ext === 'zip') {
    // Windows zip：用 PowerShell Expand-Archive
    spawnSync('powershell', ['-Command', `Expand-Archive -Path '${archivePath}' -DestinationPath '${tmpExtract}' -Force`], { stdio: 'inherit' })
  } else {
    // tar.gz：优先单文件提取 node 二进制（避免符号链接问题）
    const binName = platform === 'win32' ? 'node.exe' : 'bin/node'
    const result = spawnSync('tar', ['-xzf', archivePath, '-C', tmpExtract, `${pkgName}/${binName}`], { stdio: 'inherit' })
    if (result.status !== 0) {
      // 全量解压兜底
      spawnSync('tar', ['-xzf', archivePath, '-C', tmpExtract], { stdio: 'inherit' })
    }
  }

  // 找到 node 二进制（最深匹配）
  const binName = platform === 'win32' ? 'node.exe' : 'node'
  let nodeBin = null
  function findBin(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        findBin(full)
      } else if (entry === binName) {
        nodeBin = full
      }
    }
  }
  findBin(tmpExtract)

  if (!nodeBin) throw new Error(`解压后未找到 ${binName}`)
  const destBin = join(destDir, binName)
  copyFileSync(nodeBin, destBin)
  // 非 Windows 设可执行权限
  if (platform !== 'win32') {
    spawnSync('chmod', ['+x', destBin])
  }

  // 清理临时文件
  rmSync(archivePath, { force: true })
  rmSync(tmpExtract, { recursive: true, force: true })
  console.log(`[fetch-node] ✅ Node 二进制已 vendor: ${destBin}`)
  return destBin
}

/** 本机模式：复制当前 process.execPath。 */
function copyLocalNode(destDir) {
  const binName = process.platform === 'win32' ? 'node.exe' : 'node'
  const dest = join(destDir, binName)
  // process.execPath 必须是系统 node（不是 electron）
  if (process.versions.electron) {
    throw new Error('必须在系统 node 下运行此脚本，不能在 electron 下（ABI 不匹配）')
  }
  copyFileSync(process.execPath, dest)
  if (process.platform !== 'win32') {
    spawnSync('chmod', ['+x', dest])
  }
  console.log(`[fetch-node] ✅ 本机 Node 已复制: ${dest} (${process.version})`)
  return dest
}

async function main() {
  const args = parseArgs()
  mkdirSync(VENDOR_DIR, { recursive: true })

  const isCross = args.platform !== process.platform || args.arch !== process.arch
  if (isCross) {
    console.log(`[fetch-node] 跨平台模式: ${args.platform}/${args.arch}（本机 ${process.platform}/${process.arch}）`)
    await downloadNode(args.platform, args.arch, VENDOR_DIR)
  } else {
    console.log('[fetch-node] 本机模式')
    copyLocalNode(VENDOR_DIR)
  }
}

main().catch((err) => {
  console.error('[fetch-node] ❌', err.message ?? err)
  process.exit(1)
})
