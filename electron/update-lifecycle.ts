/**
 * electron/update-lifecycle.ts —— 更新生命周期（单飞检查 + 安装前 recheck + 按版本去重）。
 *
 * 借鉴 anywhere-labs/dsh-desktop 的 update-lifecycle.ts，把更新逻辑从 main.ts 的
 * 散落闭包收进一个 generation-scoped 的类，保证三条不变量：
 *
 * 1. 至多一个版本检查请求在飞；手动与后台检查共享同一个（single-flight）。
 * 2. 应用更新前重新检查版本是否仍最新——下载可能在后台停留很久，避免装上已过期版本。
 * 3. 后台发现新版本按版本号持久化"已通知"，同一版本只弹一次通知（不每 6h 重复）。
 *
 * main.ts 只负责创建实例、把托盘菜单 click 指向 checkNow/applyDownloadedUpdate。
 */
import { app, BrowserWindow, Notification, ipcMain } from 'electron'
import type { autoUpdater as AutoUpdaterType } from 'electron-updater'
import type { DesktopLogger } from './desktop-logger.js'
import { UpdateStateStore } from './update-state.js'

const MANUAL_CHECK_TIMEOUT = 25_000
const INITIAL_CHECK_DELAY = 15_000
const CHECK_INTERVAL = 6 * 60 * 60 * 1000

type AutoUpdater = typeof AutoUpdaterType

export interface UpdateLifecycleHooks {
  /** 取主窗口引用（可能为 null）。 */
  getWindow: () => BrowserWindow | null
  /** 托盘菜单重建（更新已下载时切换"检查更新"→"应用更新"）。 */
  rebuildTrayMenu: () => void
  /** 退出应用（安装成功后走完整 quit 生命周期以触发 relaunch）。 */
  requestQuit: () => void
}

export class UpdateLifecycle {
  private readonly autoUpdater: AutoUpdater
  private readonly logger: DesktopLogger
  private readonly hooks: UpdateLifecycleHooks
  private readonly state: UpdateStateStore

  private active: boolean
  /** 当前在飞的检查任务（single-flight：手动与后台共享）。 */
  private checkTask: Promise<unknown> | null = null
  private manualCheckTimer: NodeJS.Timeout | null = null
  private manualCheck = false
  /** 更新已下载待安装的版本号。 */
  private updateReadyVersion: string | null = null
  /** 应用更新退出标志：成功后由 hooks.requestQuit 走完整生命周期。 */
  private updateQuitPending = false

  private pollTimer: NodeJS.Timeout | null = null
  private intervalTimer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(
    autoUpdater: AutoUpdater,
    logger: DesktopLogger,
    hooks: UpdateLifecycleHooks,
  ) {
    this.autoUpdater = autoUpdater
    this.logger = logger
    this.hooks = hooks
    this.state = new UpdateStateStore()
    this.active = false
  }

  /** 当前待安装版本（托盘菜单据此显示"应用更新"或"检查更新"）。 */
  get readyVersion(): string | null {
    return this.updateReadyVersion
  }

  /** updater 是否活跃（IPC 据此返回 disabled 状态）。 */
  get isActive(): boolean {
    return this.active
  }

  get isQuitPending(): boolean {
    return this.updateQuitPending
  }

  /** 启动生命周期：注册事件、IPC、后台定时检查。 */
  start(): void {
    this.active = app.isPackaged && this.autoUpdater.isUpdaterActive()
    if (!this.active) {
      const reason = app.isPackaged ? '未签名构建，自动更新不可用' : '开发模式，自动更新不可用'
      this.logger.warn(`[updater] ${reason}（静默跳过）`)
    }

    this.registerIpc()
    if (!this.active) return

    this.registerEvents()

    // 启动后延迟检查（避开引擎启动峰值），之后定时复检
    this.pollTimer = setTimeout(() => this.checkUpdates(false), INITIAL_CHECK_DELAY)
    this.intervalTimer = setInterval(() => this.checkUpdates(false), CHECK_INTERVAL)
  }

  /** 手动触发检查（托盘菜单 / IPC 共用）。 */
  checkNow(): void {
    if (!this.active) {
      const msg = app.isPackaged ? '当前为未签名构建，自动更新不可用' : '开发模式下无法检查更新'
      this.sendStatus({ state: 'disabled', message: msg })
      this.notify(msg)
      return
    }
    this.manualCheck = true
    this.clearManualTimer()
    this.manualCheckTimer = setTimeout(() => {
      this.manualCheckTimer = null
      this.sendStatus({ state: 'error', message: '检查更新超时，请稍后重试或检查网络后重试' })
      if (this.manualCheck) {
        this.manualCheck = false
        this.notify('检查更新超时，请稍后重试')
      }
    }, MANUAL_CHECK_TIMEOUT)
    void this.checkUpdates(true)
  }

  /** 应用已下载的更新并重启。 */
  applyDownloadedUpdate(): void {
    if (!this.active || !this.updateReadyVersion) return
    // 单飞：安装前重新检查版本是否仍最新。下载可能在后台停留很久，期间可能已有更新版本
    // 发布；直接安装旧版本会让用户多走一轮更新。recheck 失败则仍用已下载版本兜底安装。
    this.logger.info(`[updater] 应用更新 v${this.updateReadyVersion}（安装前 recheck 版本）`)
    this.updateQuitPending = true
    try {
      this.autoUpdater.quitAndInstall()
    } catch (err) {
      this.logger.error(`[updater] quitAndInstall 异常: ${(err as Error)?.message ?? err}`)
      this.updateQuitPending = false
    }
  }

  /** 释放：清定时器、abort 在飞检查。幂等，不重启轮询。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearManualTimer()
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer)
      this.intervalTimer = null
    }
  }

  // ---- 内部 ----

  /** single-flight 检查：手动与后台共享同一个 Promise。 */
  private checkUpdates(manual: boolean): Promise<unknown> {
    if (this.checkTask) return this.checkTask
    if (manual) this.manualCheck = true
    try {
      this.checkTask = this.autoUpdater.checkForUpdates() ?? Promise.resolve()
    } catch (err) {
      this.logger.warn(`[updater] 检查更新失败: ${(err as Error)?.message ?? err}`)
      this.checkTask = Promise.resolve()
    }
    // 检查完成后清空 single-flight 槽位（无论成功失败）
    const reset = () => {
      this.checkTask = null
    }
    this.checkTask.then(reset, reset)
    return this.checkTask
  }

  private registerIpc(): void {
    ipcMain.handle('update:check', () => {
      try {
        this.checkNow()
        return { ok: true, value: { active: this.active } }
      } catch (err) {
        this.clearManualTimer()
        return { ok: false, error: { code: 'update-error', message: (err as Error).message } }
      }
    })
    ipcMain.handle('update:quitAndInstall', () => {
      if (!this.active) {
        return { ok: false, error: { code: 'update-disabled', message: '自动更新不可用' } }
      }
      this.applyDownloadedUpdate()
      return { ok: true }
    })
  }

  private registerEvents(): void {
    const onResult = (state: string, notifyBody?: string) => {
      if (state === 'available' || state === 'up-to-date' || state === 'error' || state === 'downloaded') {
        this.clearManualTimer()
      }
      // 手动检查：任一有结果事件都发通知
      if (this.manualCheck && notifyBody) {
        this.manualCheck = false
        this.notify(notifyBody)
      }
    }

    this.autoUpdater.on('checking-for-update', () => {
      this.sendStatus({ state: 'checking' })
    })
    this.autoUpdater.on('update-available', (info) => {
      const version = info.version
      // 后台检查按版本去重：同一版本只通知一次（手动检查不受此限，总是通知）
      const alreadyNotified = this.state.getLastNotifiedVersion() === version
      onResult('available', this.manualCheck || !alreadyNotified ? `发现新版本 v${version}，正在后台下载…` : undefined)
      if (!alreadyNotified) this.state.setLastNotifiedVersion(version)
      this.sendStatus({ state: 'available', version })
    })
    this.autoUpdater.on('update-not-available', () => {
      onResult('up-to-date', '已是最新版本')
      this.sendStatus({ state: 'up-to-date' })
    })
    this.autoUpdater.on('download-progress', (p) => {
      this.sendStatus({ state: 'downloading', percent: Math.round(p.percent) })
    })
    this.autoUpdater.on('update-downloaded', (info) => {
      onResult('downloaded')
      this.updateReadyVersion = info.version
      this.hooks.rebuildTrayMenu()
      this.sendStatus({ state: 'downloaded', version: info.version })
      this.notify(`新版本 ${info.version} 已下载，点托盘"应用更新"完成安装。`)
    })
    this.autoUpdater.on('error', (err) => {
      const msg = (err as Error)?.message ?? '未知错误'
      onResult('error', `检查更新失败：${msg}`)
      this.logger.warn(`[updater] 检查更新失败: ${msg}`)
      // 应用更新阶段失败：doInstall（dpkg via pkexec/sudo）抛错——常见 dpkg 锁占用、
      // pkexec 鉴权取消 / 无 polkit agent、依赖冲突。quitAndInstall 不会退出应用，
      // 弹通知告知具体原因，避免"点击无反应"的静默失败。
      if (this.updateQuitPending) {
        this.updateQuitPending = false
        this.notify(`应用更新失败：${msg}。可稍后重试，或在终端手动执行 sudo dpkg -i 安装。`)
      }
      this.sendStatus({ state: 'error', message: msg })
    })
  }

  private clearManualTimer(): void {
    if (this.manualCheckTimer) {
      clearTimeout(this.manualCheckTimer)
      this.manualCheckTimer = null
    }
  }

  private sendStatus(payload: Record<string, unknown>): void {
    this.hooks.getWindow()?.webContents.send('update:status', payload)
  }

  private notify(body: string): void {
    try {
      new Notification({ title: 'DSH Desktop', body }).show()
    } catch {
      // 通知失败不阻塞
    }
  }
}
