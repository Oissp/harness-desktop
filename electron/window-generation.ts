/**
 * electron/window-generation.ts —— 主窗口 Shell generation。
 *
 * 借鉴 anywhere-labs/dsh-desktop 的 ElectronShellGeneration：把 BrowserWindow、
 * 导航防护监听、引擎端口跟踪收进一个 generation-scoped 对象，release() 幂等释放。
 *
 * 本项目单平台 + 关闭到托盘，不需要完整的 generation dispose/recreate，但引擎
 * 崩溃重启换端口时窗口要重新 loadURL + 重置导航白名单——这些状态原本散落在
 * main.ts 的模块级变量（loadedEnginePort）和匿名监听器里，端口漂移时容易遗留
 * 旧监听器或白名单失效。收进此类后，引擎恢复路径只需调 loadFallback() /
 * loadEngineUI()，状态自洽。
 */
import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'

export interface WindowGenerationHooks {
  /** 窗口被用户关闭（X）时：隐藏到托盘而非销毁（返回 true=已处理）。 */
  onHideToTray: () => void
  /** preload 路径（打包后 dist-electron 内）。 */
  preloadPath: string
  /** 应用根目录（app.getAppPath()）。 */
  appPath: string
  /** dev server URL（有则加载它，否则加载打包 index.html）。 */
  devServerUrl: string | undefined
}

/** 主窗口 generation：拥有 BrowserWindow + 导航防护 + 引擎端口跟踪。 */
export class MainWindowGeneration {
  private readonly win: BrowserWindow
  private readonly hooks: WindowGenerationHooks
  /** 当前窗口指向的引擎端口（防重复 loadURL；导航白名单精确匹配）。 */
  private loadedEnginePort: number | null = null
  private released = false
  /** 应用正在退出（更新或关机）：close 处理器据此放行窗口关闭，不再 hide 到托盘。 */
  private quitting = false

  constructor(hooks: WindowGenerationHooks) {
    this.hooks = hooks
    this.win = new BrowserWindow({
      width: 1180,
      height: 780,
      minWidth: 900,
      minHeight: 620,
      title: 'DSH Desktop',
      icon: join(hooks.appPath, 'build', 'icon.png'),
      backgroundColor: '#0f1115',
      webPreferences: {
        preload: hooks.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        // sandbox 保持 false：preload 编译为 ESM，sandbox 下仅支持 CJS 会崩溃。
        // 安全补偿：webSecurity + 严格 CSP + 导航防护。
        sandbox: false,
        webSecurity: true,
      },
    })

    this.bindLifecycle()
    this.loadFallback()
  }

  get window(): BrowserWindow {
    return this.win
  }

  get isDestroyed(): boolean {
    return this.win.isDestroyed()
  }

  /** 标记应用正在退出（更新安装 / 关机）：close 处理器据此放行窗口关闭。 */
  markQuitting(): void {
    this.quitting = true
  }

  /** 当前加载的引擎端口（null = 回退屏）。 */
  get enginePort(): number | null {
    return this.loadedEnginePort
  }

  /** 加载本地回退屏（启动 / 引擎崩溃恢复态）。 */
  loadFallback(): void {
    if (this.released || this.win.isDestroyed()) return
    this.loadedEnginePort = null
    const { devServerUrl, appPath } = this.hooks
    if (devServerUrl) {
      void this.win.loadURL(devServerUrl)
    } else {
      void this.win.loadFile(join(appPath, 'dist', 'index.html'))
    }
  }

  /**
   * 加载官方引擎 UI。端口变化时重新加载；失败递增重试。
   * 端口已变（引擎又重启换新端口）→ 旧端口的重试自动放弃。
   */
  loadEngineUI(port: number, token: string | null): void {
    if (this.released || this.win.isDestroyed()) return
    if (this.loadedEnginePort === port) return
    this.loadedEnginePort = port
    const url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(token ?? '')}`
    let attempt = 0
    const tryLoad = (): void => {
      if (this.released || this.win.isDestroyed()) return
      // 端口已变（引擎重启换新端口触发新的 loadEngineUI）→ 放弃旧端口重试
      if (this.loadedEnginePort !== port) return
      void this.win.loadURL(url).catch((err) => {
        // 落盘日志由 main.ts 的 logger 处理；这里只做重试调度
        void err
        if (this.loadedEnginePort === port) this.loadedEnginePort = null
        attempt += 1
        if (attempt <= 10) {
          const delay = attempt === 1 ? 1000 : attempt === 2 ? 2000 : Math.min(5000 * attempt, 30000)
          setTimeout(tryLoad, delay)
        }
      })
    }
    tryLoad()
  }

  /** 幂等释放：解绑监听。窗口本身的销毁由 Electron 的 closed 事件处理。 */
  release(): void {
    if (this.released) return
    this.released = true
    this.loadedEnginePort = null
  }

  // ---- 内部 ----

  private bindLifecycle(): void {
    // 引擎 UI <title> 会覆盖窗口标题，强制保持 "DSH Desktop"
    this.win.on('page-title-updated', (e) => {
      e.preventDefault()
    })

    this.win.on('closed', () => {
      this.release()
    })

    // 关闭窗口（X）→ 隐藏到托盘。但应用正在退出（更新安装 / 关机）时放行关闭，
    // 否则 preventDefault 会 abort app.quit()，导致更新装完老进程不退、新进程不启。
    this.win.on('close', (e) => {
      if (this.released || this.quitting) return
      e.preventDefault()
      this.win.hide()
      this.hooks.onHideToTray()
    })

    // 新窗口：仅 http/https 外部链接走系统浏览器
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://') || url.startsWith('http://')) {
        void shell.openExternal(url)
      }
      return { action: 'deny' }
    })

    // 导航白名单：dev server / 打包文件 / 精确引擎端口，其余阻止
    this.win.webContents.on('will-navigate', (event, url) => {
      const isEngine = this.loadedEnginePort !== null && url.startsWith(`http://127.0.0.1:${this.loadedEnginePort}`)
      const isDev = this.hooks.devServerUrl ? url.startsWith(this.hooks.devServerUrl) : false
      const isFile = url.startsWith('file://')
      if (!isEngine && !isDev && !isFile) event.preventDefault()
    })
  }
}
