/**
 * electron/dsh-manager.ts —— dsh 引擎子进程生命周期管理。
 *
 * 职责：
 *  - 定位 dsh 可执行入口（开发环境用系统 node，打包环境用 ELECTRON_RUN_AS_NODE）
 *  - 以 `web --host 127.0.0.1 --port 0` 启动 dsh，随机回环端口
 *  - 解析 stdout 拿到实际端口，轮询 host.describe 直到就绪
 *  - 退出时优雅终止子进程（SIGTERM → SIGKILL）
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { DshAdapter } from '../adapter/index.js'
import { checkProfile } from './profile-setup.js'
import { CrashLoopDetector } from './crash-loop-detector.js'
import { takeBootSnapshot, promoteToLastGood, restoreFromLastGood } from './guard-snapshot.js'
import type { SessionStreamEvent } from '../shared/types.js'

const READY_TIMEOUT_MS = 90_000
const KILL_TIMEOUT_MS = 5_000
/** 引擎稳定运行的判定时间：就绪后持续运行此时长才认定"稳定"，提升快照 + 重置崩溃环。 */
const STABLE_BOOT_MS = 45_000
/** 崩溃后自动重启延迟（ms）。 */
const AUTO_RESTART_DELAY_MS = 2_000

/** dsh bin.js 的候选路径（开发 = 项目 node_modules；打包 = asar 内）。 */
function resolveDshBin(): string {
  const candidates = [
    join(app.getAppPath(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    join(process.resourcesPath ?? '', 'app.asar', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new Error('无法定位 dsh 引擎（@deepseek-ai/dsh/lib/bin.js）')
}

/**
 * 解析可用的 Node 二进制。
 * 优先级：vendored 独立 node > 系统 node > electron-as-node。
 *
 * vendored node（vendor/node/node 或 node.exe）ABI 与系统 Node 一致，
 * 预编译原生模块（koffi/node-pty）能正常加载，避免 ELECTRON_RUN_AS_NODE
 * 下 ABI 不匹配导致的模块加载失败。
 */
function resolveNodeBinary(): { exec: string; isElectron: boolean } {
  // 1. vendored 独立 Node（fetch-node.mjs 产物）——打包后也在 app 目录内
  const binName = process.platform === 'win32' ? 'node.exe' : 'node'
  const vendoredCandidates = [
    join(app.getAppPath(), 'vendor', 'node', binName),
    join(process.resourcesPath ?? '', 'app', 'vendor', 'node', binName),
  ]
  for (const c of vendoredCandidates) {
    if (existsSync(c)) return { exec: c, isElectron: false }
  }
  // 2. 系统 node（开发环境）
  const fromNpm =
    process.env.npm_node_execpath ||
    process.env.npm_config_node_execpath ||
    process.env.npm_node_install_path
  if (fromNpm && existsSync(fromNpm)) {
    return { exec: fromNpm, isElectron: false }
  }
  // 3. 兜底：electron-as-node
  return { exec: process.execPath, isElectron: true }
}

export interface DshManagerStatus {
  running: boolean
  ready: boolean
  port: number | null
  version: string | null
  cwd: string | null
  provider: string | null
  model: string | null
  error?: string
  /** 是否处于崩溃恢复态（崩溃环触发，需用户手动重启或已进入恢复页）。 */
  recovery?: boolean
}

export class DshManager {
  private proc: ChildProcess | null = null
  private adapter: DshAdapter | null = null
  private dshHome: string
  private ready = false
  private version: string | null = null
  private hostCwd: string | null = null
  private provider: string | null = null
  private model: string | null = null
  private lastError: string | null = null
  private stopping = false
  /** 崩溃恢复态：崩溃环触发后置 true，停止自动重启，等待手动恢复。 */
  private recovery = false
  /** 引擎稳定运行计时器（markGood）：就绪后 STABLE_BOOT_MS 提升快照 + 重置崩溃环。 */
  private stableTimer: ReturnType<typeof setTimeout> | null = null
  /** 崩溃环检测器。 */
  private crashDetector = new CrashLoopDetector()
  private statusListeners: ((s: DshManagerStatus) => void)[] = []
  /** 事件订阅者（renderer 通过 dsh:subscribe 注册）。adapter 未就绪时排队，创建/重建后自动接入。 */
  private eventListeners: ((evt: SessionStreamEvent) => void)[] = []
  /** 当前 adapter 上的订阅解除函数（重建 adapter 时先解除旧的）。 */
  private eventUnsubs: (() => void)[] = []

  constructor() {
    this.dshHome = join(app.getPath('userData'), 'dsh-home')
  }

  get adapterInstance(): DshAdapter | null {
    return this.adapter
  }

  get home(): string {
    return this.dshHome
  }

  /**
   * 可靠事件订阅：adapter 就绪则立即接入；未就绪则排队，adapter 创建/重建后自动接入。
   * @returns 解除订阅函数。
   */
  subscribeEvents(cb: (evt: SessionStreamEvent) => void): () => void {
    this.eventListeners.push(cb)
    if (this.adapter) {
      this.eventUnsubs.push(this.adapter.onSessionEvent(cb))
    }
    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== cb)
    }
  }

  /** adapter 创建/重建后调用：为所有订阅者重新接入事件流（补订阅 + 防端口漂移）。 */
  private rebindEventListeners() {
    const adapter = this.adapter
    if (!adapter) return
    for (const unsub of this.eventUnsubs) {
      try {
        unsub()
      } catch {
        // 忽略旧订阅解除失败
      }
    }
    this.eventUnsubs = []
    for (const cb of [...this.eventListeners]) {
      try {
        this.eventUnsubs.push(adapter.onSessionEvent(cb))
      } catch (err) {
        console.error('[harness-desktop] 事件订阅接入失败:', err)
      }
    }
  }

  onStatus(cb: (s: DshManagerStatus) => void): () => void {
    this.statusListeners.push(cb)
    return () => {
      this.statusListeners = this.statusListeners.filter((l) => l !== cb)
    }
  }

  private emitStatus() {
    const s = this.status()
    for (const listener of [...this.statusListeners]) listener(s)
  }

  status(): DshManagerStatus {
    return {
      running: this.proc !== null && this.proc.exitCode === null,
      ready: this.ready,
      port: this.adapter?.client.port ?? null,
      version: this.version,
      cwd: this.hostCwd,
      provider: this.provider,
      model: this.model,
      error: this.lastError ?? undefined,
      recovery: this.recovery,
    }
  }

  /**
   * 手动重启内核（恢复页"重启内核"按钮调用）。
   * 清除崩溃环检测器，重新走完整 boot 流程。
   */
  async restart(): Promise<DshManagerStatus> {
    this.crashDetector.reset()
    this.recovery = false
    this.lastError = null
    await this.stop()
    return this.start()
  }

  /** 启动（若已就绪则直接返回）。返回就绪后的状态快照。 */
  async start(): Promise<DshManagerStatus> {
    if (this.ready && this.adapter) return this.status()
    if (this.proc && this.proc.exitCode === null) {
      // 已启动但尚未就绪 → 等待就绪
      return this.waitUntilReady()
    }
    this.lastError = null

    // 确保 profile 就绪 + 记忆插件已安装
    const setup = checkProfile(this.dshHome, app.getAppPath())
    if (setup.status === 'needs-priming') {
      // 首次启动：先跑一次引擎让 profile 完成初始化，再装插件，然后正式启动
      await this.spawn()
      try {
        await this.waitUntilReady()
      } catch {
        // profile 初始化失败也不阻塞；记录日志继续
      }
      await this.stop()
      checkProfile(this.dshHome, app.getAppPath())
    } else if (setup.status === 'skip') {
      console.warn('[harness-desktop] 记忆插件不可用（非致命）:', setup.reason)
    }

    // 守护瀑布：boot 前拍配置快照（失败时可回滚到 last-good）
    // 快照失败不阻断 boot——磁盘满/权限问题不应阻止引擎启动，降级为无快照继续
    try {
      takeBootSnapshot(this.dshHome)
    } catch (err) {
      console.warn('[harness-desktop] 配置快照失败，跳过守护瀑布:', err)
    }

    await this.spawn()
    try {
      return await this.waitUntilReady()
    } catch (err) {
      // 第一层失败：尝试回滚坏配置后重试一次（对应守护瀑布第二层）
      const restored = restoreFromLastGood(this.dshHome)
      if (restored > 0) {
        console.warn('[harness-desktop] 检测到坏配置，已从最后良好快照回滚，重试启动…')
        // 先停止第一次的子进程：waitUntilReady 超时意味着子进程可能仍存活，
        // 直接再 spawn 会孤儿第一个进程，且其 exit handler 会回写 this.proc
        // 竞态破坏第二个进程的生命周期状态
        await this.stop()
        await this.spawn()
        return await this.waitUntilReady()
      }
      throw err
    }
  }

  private async spawn(): Promise<void> {
    const bin = resolveDshBin()
    const { exec, isElectron } = resolveNodeBinary()
    const env = {
      ...process.env,
      DSH_HOME: this.dshHome,
      ...(isElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    }
    // --no-open：dsh web 默认会把 UI URL 交给系统默认浏览器打开（openBrowser 默认 true）。
    // 桌面端已由 Electron 的 BrowserWindow 加载引擎 UI，不需要 dsh 再开浏览器，否则会
    // 多出一个浏览器窗口（见 dsh-web-app/lib/index.js handoffBrowser）。
    const args = ['--expose-internals', bin, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open']

    const child = spawn(exec, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.proc = child

    child.stdout?.on('data', (chunk: Buffer) => this.handleStdout(String(chunk)))
    child.stderr?.on('data', (chunk: Buffer) => this.handleStderr(String(chunk)))

    child.on('error', (err) => {
      this.lastError = `dsh 进程启动失败: ${err.message}`
      this.emitStatus()
    })

    child.on('exit', (code, signal) => {
      const wasRunning = this.ready
      this.ready = false
      // 引擎退出 → 取消稳定计时器（未达稳定，不提升快照）
      if (this.stableTimer) {
        clearTimeout(this.stableTimer)
        this.stableTimer = null
      }
      this.adapter?.close()
      this.adapter = null
      this.proc = null
      // 解除旧 adapter 上的订阅（eventListeners 保留，重建 adapter 后重新接入）
      for (const unsub of this.eventUnsubs) {
        try {
          unsub()
        } catch {
          // 忽略
        }
      }
      this.eventUnsubs = []
      if (!this.stopping) {
        this.lastError = `dsh 进程退出（code=${code ?? ''} signal=${signal ?? ''}）`
        if (wasRunning) {
          // 崩溃环检测：决定是否自动重启
          const verdict = this.crashDetector.recordCrash()
          if (verdict === 'ok') {
            // 允许自动重启（延迟，避免立即重启竞态）
            setTimeout(() => {
              if (!this.stopping) void this.start().catch(() => undefined)
            }, AUTO_RESTART_DELAY_MS)
          } else {
            // 崩溃环触发 → 进入恢复态，停止自动重启
            this.recovery = true
            this.lastError = `引擎反复崩溃（${verdict === 'tripped' ? '快环' : '慢环'}熔断），已进入恢复态。请检查配置后重启内核。`
          }
        }
      }
      this.emitStatus()
    })
  }

  private handleStdout(chunk: string) {
    const match = chunk.match(/http:\/\/127\.0\.0\.1:(\d+)/)
    if (match && !this.adapter) {
      const port = Number(match[1])
      this.adapter = new DshAdapter(port)
      // 事件订阅补接：adapter 刚创建，把排队/已有订阅者接上（修复订阅竞态）
      this.rebindEventListeners()
    }
  }

  private handleStderr(chunk: string) {
    const line = chunk.trim()
    if (line) this.lastError = line.slice(0, 300)
  }

  private async waitUntilReady(): Promise<DshManagerStatus> {
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.stopping) throw new Error('dsh 正在停止')
      const adapter = this.adapter
      if (adapter && (await adapter.isReady())) {
        this.ready = true
        try {
          const d = await adapter.describe()
          this.version = d.version
          this.hostCwd = d.cwd
          this.provider = d.provider ?? null
          this.model = d.model ?? null
          this.lastError = null
        } catch {
          // 描述失败不影响就绪
        }
        // 守护瀑布 markGood：引擎稳定运行 STABLE_BOOT_MS 后提升快照 + 重置崩溃环。
        // 对应参考项目的 45s 稳定落定。若引擎在此期间崩溃，exit 回调会取消此计时器。
        if (this.stableTimer) clearTimeout(this.stableTimer)
        this.stableTimer = setTimeout(() => {
          try {
            this.crashDetector.recordGoodBoot()
            promoteToLastGood(this.dshHome)
          } catch (err) {
            // 快照提升失败不 crash 主进程（磁盘满/目录被删等），仅记录
            console.warn('[harness-desktop] 提升最后良好快照失败:', err)
          }
          this.stableTimer = null
        }, STABLE_BOOT_MS)
        this.emitStatus()
        return this.status()
      }
      await sleep(500)
    }
    this.lastError = 'dsh 启动超时'
    this.emitStatus()
    throw new Error('dsh 启动超时')
  }

  /** 优雅停止 dsh 子进程。 */
  async stop(): Promise<void> {
    this.stopping = true
    // 停止时取消稳定计时器
    if (this.stableTimer) {
      clearTimeout(this.stableTimer)
      this.stableTimer = null
    }
    const child = this.proc
    if (!child) {
      this.stopping = false
      return
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        this.proc = null
        this.adapter?.close()
        this.adapter = null
        this.ready = false
        this.eventUnsubs = []
        this.stopping = false
        this.emitStatus()
        resolve()
      }
      if (child.exitCode !== null) return done()
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        setTimeout(done, 300)
      }, KILL_TIMEOUT_MS)
      child.once('exit', () => {
        clearTimeout(timer)
        done()
      })
      child.kill('SIGTERM')
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
