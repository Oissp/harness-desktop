/**
 * scripts/smoke-test.mjs —— 打包后运行时烟雾测试。
 *
 * verify-deb.mjs 只校验静态结构，不能发现"装上即崩"的运行时问题（依赖闭包
 * 缺失、原生模块 ABI 不符、ESM 入口解析失败等会到运行时才暴露）。本脚本
 * 实际启动 linux-unpacked 产物几秒，断言主进程不立即退出、日志文件被创建、
 * 关键模块（log-sink / update-lifecycle / dsh-manager）可加载。
 *
 * 借鉴 anywhere-labs/dsh-desktop 的 verify-packaged-runtime.ts。
 *
 * 用法：node scripts/smoke-test.mjs [out/linux-unpacked]
 * 退出码：0 通过，1 失败。CI 中放在 verify-deb 之后。
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const unpackedDir = resolve(process.argv[2] ?? 'out/linux-unpacked')
const executable = join(unpackedDir, 'dsh-desktop')

let failures = 0
const fail = (msg) => {
  console.error(`  ✗ ${msg}`)
  failures++
}
const ok = (msg) => console.log(`  ✓ ${msg}`)

console.log(`\n[smoke] 启动烟雾测试：${unpackedDir}`)

if (!existsSync(executable)) {
  fail(`未找到可执行文件 ${executable}`)
  console.error(`\n[smoke] 失败：${failures} 项`)
  process.exit(1)
}

// 用临时 HOME 隔离，避免污染 CI 环境 / 触发单实例锁冲突
const tmpHome = join(unpackedDir, '.smoke-home')
rmSync(tmpHome, { recursive: true, force: true })

const mainJs = join(unpackedDir, 'resources', 'app', 'dist-electron', 'electron', 'main.js')
if (!existsSync(mainJs)) {
  fail(`主进程入口缺失 ${mainJs}`)
}

// 关键运行时依赖闭包存在性（静态侧 verify-deb 已覆盖，这里做轻量再确认）
const nmRoot = join(unpackedDir, 'resources', 'app', 'node_modules')
for (const dep of ['@deepseek-ai/dsh', 'electron-updater', 'koffi']) {
  if (!existsSync(join(nmRoot, dep))) {
    fail(`依赖闭包缺失：${dep}`)
  }
}

if (failures > 0) {
  console.error(`\n[smoke] 静态预检失败：${failures} 项，跳过启动测试`)
  process.exit(1)
}
ok('静态预检通过（入口 + 依赖闭包）')

// 启动应用，观察 8 秒：不应在窗口就绪前崩溃退出。
// --no-sandbox：CI 容器无 sandbox 权限；不影响主进程加载验证。
const env = {
  ...process.env,
  HOME: tmpHome,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '/tmp',
  // 阻止自动更新发起网络请求（CI 无网络 / 不应触发）
  DSH_DESKTOP_SMOKE: '1',
  DISPLAY: process.env.DISPLAY ?? '',
}

const child = spawn(executable, ['--no-sandbox', '--disable-gpu'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  cwd: unpackedDir,
})

let stdout = ''
let stderr = ''
let exitedEarly = false
let exitCode = null
const startTime = Date.now()

child.stdout.on('data', (d) => { stdout += d.toString() })
child.stderr.on('data', (d) => { stderr += d.toString() })

child.on('exit', (code, signal) => {
  if (Date.now() - startTime < 7000) {
    exitedEarly = true
    exitCode = code ?? signal
  }
})

// 给主进程最多 8 秒初始化：app.whenReady → 日志写入 → dsh 启动
await new Promise((resolve) => setTimeout(resolve, 8000))

// 主动结束
try {
  child.kill('SIGTERM')
} catch {
  // 忽略
}
await new Promise((resolve) => {
  child.once('exit', resolve)
  setTimeout(resolve, 2000)
})

// ---- 断言 ----

if (exitedEarly) {
  fail(`主进程在 7s 内退出（code=${exitCode}），疑似启动即崩`)
  console.error('  --- stderr (末 2000 字符) ---')
  console.error(stderr.slice(-2000))
} else {
  ok('主进程存活超过 7s，未立即崩溃')
}

// 日志目录应被创建（log-sink 在 app.whenReady 前初始化）
const logDir = join(tmpHome, '.config', 'dsh-desktop', 'logs')
if (existsSync(logDir)) {
  const logs = readdirSync(logDir).filter((f) => f.endsWith('.log'))
  if (logs.length > 0) {
    ok(`日志文件已创建：${logs.join(', ')}`)
  } else {
    fail('日志目录存在但无日志文件')
  }
} else {
  // userData 路径可能因 app name 不同而异，放宽检查：搜索 .config 下任意 logs 目录
  const configDir = join(tmpHome, '.config')
  let foundLog = false
  if (existsSync(configDir)) {
    for (const sub of readdirSync(configDir)) {
      const candidate = join(configDir, sub, 'logs')
      if (existsSync(candidate) && readdirSync(candidate).some((f) => f.endsWith('.log'))) {
        ok(`日志文件已创建（${candidate}）`)
        foundLog = true
        break
      }
    }
  }
  if (!foundLog) fail('未找到日志目录（log-sink 未初始化或 userData 路径异常）')
}

// stderr 中不应出现未捕获异常 / 模块加载失败
const fatalPatterns = [
  /Cannot find module/,
  /Error: Cannot find/,
  /MODULE_NOT_FOUND/,
  /Uncaught Error/,
  /A dynamic link library/,
  /was compiled against a different Node\.js version/,
]
const fatalHits = fatalPatterns
  .map((re) => {
    const m = stderr.match(re)
    return m ? m[0] : null
  })
  .filter(Boolean)
if (fatalHits.length > 0) {
  fail(`stderr 含致命错误：${[...new Set(fatalHits)].join('; ')}`)
} else {
  ok('stderr 无模块加载 / 未捕获异常')
}

// 清理
rmSync(tmpHome, { recursive: true, force: true })

console.log(`\n[smoke] ${failures === 0 ? '通过' : `失败：${failures} 项`}`)
process.exit(failures === 0 ? 0 : 1)
