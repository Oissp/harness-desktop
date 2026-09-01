/**
 * electron/main.ts —— 应用入口。
 */
import { app, BrowserWindow, Menu, Tray, Notification, nativeImage, shell, ipcMain } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DshManager } from './dsh-manager.js'
import { SettingsStore } from './settings-store.js'
import { registerIpc } from './ipc.js'
import { createCredentialStore, userDataDir } from './credential-store.js'
import { migrateUserData } from './migrate-userdata.js'
import updaterModule from 'electron-updater'
// electron-updater 是 CJS；ESM 下具名导出互操作不可靠，取 default 对象的 autoUpdater
const { autoUpdater } = updaterModule as { autoUpdater: typeof import('electron-updater')['autoUpdater'] }

const __dirname = dirname(fileURLToPath(import.meta.url))
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

// userData 路径迁移：旧版用 app.setName('harness-desktop') 锁定路径，现已改为
// 启动时一次性搬迁数据到 Electron 自然路径（~/.config/dsh-desktop/）。
// 必须在 whenReady 前、模块级顶层调用（此时 app.getPath 已可用）。
{
  const newUserData = app.getPath('userData') // 自然路径：~/.config/dsh-desktop/
  const configBase = dirname(newUserData)
  migrateUserData(newUserData, [
    join(configBase, 'harness-desktop'),
    join(configBase, 'DSH Desktop', 'harness-desktop'),
    join(configBase, 'DSH Desktop'),
  ])
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let manager: DshManager
let settings: SettingsStore
let disposeIpc: () => void = () => {}
let quitting = false
let trayHintShown = false

// ---- 自动更新（021）：启动后台检查 + 手动检查 ----
// 注意：macOS 自动更新依赖代码签名（017）；未签名时自动更新被禁用，静默跳过。
autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true
// electron-updater 按 semver 预发布标识符划分更新通道：0.1.1-rc.2 属 "rc" 通道，
// 1.0.0 属稳定通道。本仓库自 1.0.0 起用应用自身版本号（与 dsh 引擎版本解耦），
// 但仍有 0.1.x 预发布版用户需要跨通道升级到稳定版。固定 allowPrerelease=true 并把
// 检查通道设为 "alpha"（落入 alpha/beta 特殊集合 → shouldFetchVersion=true），可使
// 预发布版用户匹配到稳定版 release（hrefChannel=null 也命中）；稳定版用户同样能
// 发现新稳定版。待所有用户迁移到 1.0.0+ 后可移除这两行，回归默认的 /releases/latest 路径。
autoUpdater.allowPrerelease = true
autoUpdater.channel = 'alpha'

// 托盘菜单"检查更新"复用的统一触发入口（setupUpdater 里赋值）。
// 托盘与 IPC 都走它，保证 disabled/超时/通知逻辑一致。
let triggerManualUpdateCheck: () => void = () => {}

// 更新已下载待安装：downloaded 后置位，托盘菜单"检查更新"切为"应用更新"。
// 正常运行时窗口指向官方引擎 UI，桌面 React 侧边栏不可见，托盘是唯一持久入口，
// 故在此提供"一键应用更新"，免去用户退出应用再重开的绕路。
let updateReadyVersion: string | null = null
let updaterActive = false

function setupUpdater() {
  // updater 是否活跃：仅打包 + 已签名（macOS）/ 正常 Linux 构建时为 true。
  // dev 模式与未签名构建下为 false —— 此时仍注册 IPC handler（返回 active=false
  // 并下发 disabled 状态），避免渲染层 invoke 到未注册通道而报原始错误。
  const active = app.isPackaged && autoUpdater.isUpdaterActive()
  updaterActive = active
  if (!active) {
    const reason = app.isPackaged ? '未签名构建，自动更新不可用' : '开发模式，自动更新不可用'
    console.warn(`[dsh-desktop] ${reason}（静默跳过）`)
  }

  // 手动检查的超时兜底：checkForUpdates() 是 fire-and-forget，状态靠 update:status
  // 事件回流。若网络/registry 静默失败、迟迟不发事件，前端会卡在"检查中…"。
  // 这里在手动触发后挂一个定时器，收到任一终态/有结果事件即清除；超时则下发 error。
  let manualCheckTimer: NodeJS.Timeout | null = null
  const MANUAL_CHECK_TIMEOUT = 25_000
  const clearManualTimer = () => {
    if (manualCheckTimer) {
      clearTimeout(manualCheckTimer)
      manualCheckTimer = null
    }
  }
  // 手动触发标志：区分托盘/按钮手动检查与后台定时复检。仅手动检查下发系统通知，
  // 后台复检保持静默（避免每 6h 弹通知打扰）。
  let manualCheck = false

  const notifyUpdate = (body: string) => {
    try {
      new Notification({ title: 'DSH Desktop', body }).show()
    } catch {
      // 通知失败不阻塞
    }
  }

  // 统一的手动检查入口：托盘菜单与 IPC update:check 都走这里。
  // !active 时直接通知 + 下发 disabled 状态（不挂超时、不调 autoUpdater）。
  const doManualCheck = () => {
    if (!active) {
      const msg = app.isPackaged ? '当前为未签名构建，自动更新不可用' : '开发模式下无法检查更新'
      mainWindow?.webContents.send('update:status', { state: 'disabled', message: msg })
      notifyUpdate(msg)
      return
    }
    manualCheck = true
    clearManualTimer()
    manualCheckTimer = setTimeout(() => {
      manualCheckTimer = null
      mainWindow?.webContents.send('update:status', {
        state: 'error',
        message: '检查更新超时，请稍后重试或检查网络后重试',
      })
      if (manualCheck) {
        manualCheck = false
        notifyUpdate('检查更新超时，请稍后重试')
      }
    }, MANUAL_CHECK_TIMEOUT)
    void autoUpdater.checkForUpdates()
  }
  triggerManualUpdateCheck = doManualCheck

  ipcMain.handle('update:check', () => {
    try {
      doManualCheck()
      return { ok: true, value: { active } }
    } catch (err) {
      clearManualTimer()
      return { ok: false, error: { code: 'update-error', message: (err as Error).message } }
    }
  })
  ipcMain.handle('update:quitAndInstall', () => {
    if (!active) {
      return { ok: false, error: { code: 'update-disabled', message: '自动更新不可用' } }
    }
    autoUpdater.quitAndInstall()
    return { ok: true }
  })

  // updater 不活跃时到此为止：不注册事件监听、不启动定时复检
  if (!active) return

  // 收到任一"有结果"事件即清除手动检查超时定时器；手动触发时额外发系统通知
  // （引擎 UI 状态下窗口无 onUpdateStatus 监听器，通知是唯一可见反馈）。
  const onResult = (state: string, notifyBody?: string) => {
    if (state === 'available' || state === 'up-to-date' || state === 'error' || state === 'downloaded') {
      clearManualTimer()
    }
    if (manualCheck && notifyBody) {
      manualCheck = false
      notifyUpdate(notifyBody)
    }
  }
  autoUpdater.on('checking-for-update', () => {
    mainWindow?.webContents.send('update:status', { state: 'checking' })
  })
  autoUpdater.on('update-available', (info) => {
    onResult('available', `发现新版本 v${info.version}，正在后台下载…`)
    mainWindow?.webContents.send('update:status', { state: 'available', version: info.version })
    // 后台自动下载（autoDownload=true）
  })
  autoUpdater.on('update-not-available', () => {
    onResult('up-to-date', '已是最新版本')
    mainWindow?.webContents.send('update:status', { state: 'up-to-date' })
  })
  autoUpdater.on('download-progress', (p) => {
    mainWindow?.webContents.send('update:status', {
      state: 'downloading',
      percent: Math.round(p.percent),
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    // downloaded 是重要状态：无论手动/后台都通知（重启提示）
    onResult('downloaded')
    updateReadyVersion = info.version
    rebuildTrayMenu()
    mainWindow?.webContents.send('update:status', { state: 'downloaded', version: info.version })
    notifyUpdate(`新版本 ${info.version} 已下载，点托盘"应用更新"完成安装。`)
  })
  autoUpdater.on('error', (err) => {
    onResult('error', `检查更新失败：${(err as Error)?.message ?? '未知错误'}`)
    // 失败静默（日志记录，不打扰用户）
    console.warn('[dsh-desktop] 检查更新失败:', (err as Error)?.message ?? err)
    mainWindow?.webContents.send('update:status', { state: 'error', message: err?.message })
  })

  // 启动后台检查 + 定时复检：检测 GitHub Release 新版本（v<version> + latest-linux.yml）。
  // 启动后延迟 15s 检查一次（避开引擎启动峰值），之后每 6 小时复检一次。
  // 失败静默（error 事件已记录），不打扰用户。
  const checkUpdates = () => {
    try {
      void autoUpdater.checkForUpdates()
    } catch (err) {
      console.warn('[dsh-desktop] 检查更新失败:', (err as Error)?.message ?? err)
    }
  }
  setTimeout(checkUpdates, 15_000)
  setInterval(checkUpdates, 6 * 60 * 60 * 1000)
}

/** 显示/恢复主窗口（无窗口则新建）。托盘菜单与单击共用。 */
function showWindow() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  } else {
    createWindow()
  }
}

/** 应用已下载的更新并重启。仅在 updater 活跃且有待安装版本时生效。 */
function applyDownloadedUpdate() {
  if (!updaterActive || !updateReadyVersion) return
  autoUpdater.quitAndInstall()
}

/** 构建托盘右键菜单：更新已下载时"检查更新"切为"应用更新"。 */
function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: '显示主窗口', click: showWindow },
    {
      label: '新建会话',
      click: () => {
        showWindow()
        const win = BrowserWindow.getAllWindows()[0]
        if (win && !win.isDestroyed()) win.webContents.send('menu:new-chat')
      },
    },
    updateReadyVersion
      ? { label: `应用更新 v${updateReadyVersion}`, click: applyDownloadedUpdate }
      : { label: '检查更新', click: () => triggerManualUpdateCheck() },
    { type: 'separator' },
    { label: '退出', click: () => shutdown() },
  ])
}

/** 重建托盘菜单（更新状态变化后切换"检查更新"/"应用更新"）。 */
function rebuildTrayMenu() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu())
}

/** 创建系统托盘：鲸鱼图标 + 菜单（显示/新建会话/检查更新/退出）。 */
function createTray() {
  const isMac = process.platform === 'darwin'
  const trayDir = join(app.getAppPath(), 'build', 'tray')
  const image = nativeImage.createFromPath(join(trayDir, 'TrayTemplate.png'))
  if (image.isEmpty()) {
    // 兜底：用应用图标（彩色，非 template）
    tray = new Tray(join(app.getAppPath(), 'build', 'icon.png'))
  } else if (isMac) {
    // macOS：template image 由系统自动适配菜单栏深浅色（深色栏→白，浅色栏→黑）
    image.setTemplateImage(true)
    tray = new Tray(image)
  } else {
    // Windows/Linux：任务栏不会自动反色，使用白色单色图标适配深色任务栏
    const whiteImage = nativeImage.createFromPath(join(trayDir, 'TrayWhite.png'))
    if (whiteImage.isEmpty()) {
      // 白色图标缺失时回退到 template（黑色）
      image.setTemplateImage(true)
      tray = new Tray(image)
    } else {
      tray = new Tray(whiteImage)
    }
  }
  tray.setToolTip('DSH Desktop')
  // 菜单通过 rebuildTrayMenu 设置：若启动时已有待安装更新（极少见）也能正确展示
  rebuildTrayMenu()
  // 单击托盘图标 → 显示主窗口
  tray.on('click', showWindow)
  return tray
}

// ---- 单实例锁（012）：防止双开导致 dsh 引擎抢随机端口/资源冲突 ----
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    title: 'DSH Desktop',
    icon: join(app.getAppPath(), 'build', 'icon.png'),
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox 保持 false：preload 编译为 ESM（package.json type: module），
      // sandbox 下 preload 仅支持 CommonJS/有限 require，ESM import 会崩溃。
      // 安全补偿：webSecurity（默认）+ 严格 CSP（index.html）+ 导航防护（B 部分）。
      sandbox: false,
      webSecurity: true,
    },
  })

  // 引擎 UI 页面 <title>（如 "DeepSeek Harness"）会触发 page-title-updated
  // 覆盖窗口标题。这里拦截，强制保持 "DSH Desktop"，使任务栏/标题栏品牌一致。
  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    loadedEnginePort = null
  })

  // 关闭窗口（X）→ 隐藏到托盘，不退出（托盘菜单"退出"才真正退出）
  mainWindow.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    mainWindow?.hide()
    // 首次隐藏到托盘：提示一次（不打扰）
    if (!trayHintShown) {
      trayHintShown = true
      try {
        new Notification({ title: 'DSH Desktop', body: '应用已最小化到托盘，点托盘鲸鱼图标恢复。' }).show()
      } catch {
        // 通知失败不阻塞
      }
    }
  })

  if (VITE_DEV_SERVER_URL) {
    // dev：先加载本地渲染器作为启动/回退屏，引擎就绪后由 loadEngineUI 跳转
    void mainWindow.loadURL(VITE_DEV_SERVER_URL)
  } else {
    // prod：先加载本地构建作为启动/回退屏，引擎就绪后由 loadEngineUI 跳转
    void mainWindow.loadFile(join(app.getAppPath(), 'dist', 'index.html'))
  }

  // ---- 导航防护（012） ----
  // 新窗口（如 target=_blank / window.open）：仅 http/https 外部链接走系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  // 应用窗口只能导航到自身资源（dev server / 打包文件 / 精确引擎端口），其余一律阻止
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isEngine = loadedEnginePort !== null && url.startsWith(`http://127.0.0.1:${loadedEnginePort}`)
    const isDev = VITE_DEV_SERVER_URL ? url.startsWith(VITE_DEV_SERVER_URL) : false
    const isFile = url.startsWith('file://')
    if (!isEngine && !isDev && !isFile) event.preventDefault()
  })
}

/** 当前窗口指向的引擎端口（防重复 loadURL；也用于导航白名单精确匹配）。 */
let loadedEnginePort: number | null = null

/** 把主窗口加载到官方 UI（引擎端口）。端口变化时重新加载；失败定时重试。 */
function loadEngineUI(port: number, token: string | null) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (loadedEnginePort === port) return
  loadedEnginePort = port
  const url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(token ?? '')}`
  let attempt = 0
  const tryLoad = () => {
    // 端口已变（引擎重启换新端口触发 loadEngineUI 新端口）→ 放弃旧端口重试
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (loadedEnginePort !== port) return
    void mainWindow.loadURL(url).catch((err) => {
      console.warn('[dsh-desktop] 加载官方 UI 失败:', (err as Error)?.message ?? err)
      if (loadedEnginePort === port) loadedEnginePort = null
      // 递增重试：1s/2s/5s/... 最多 10 次，避免窗口永停回退屏
      attempt += 1
      if (attempt <= 10) {
        const delay = attempt === 1 ? 1000 : attempt === 2 ? 2000 : Math.min(5000 * attempt, 30000)
        setTimeout(tryLoad, delay)
      }
    })
  }
  tryLoad()
}

/** 移除应用顶部菜单栏：构建后窗口顶部不再显示「文件/编辑/视图」等菜单。 */
function setupMenu() {
  Menu.setApplicationMenu(null)
}

/** 优雅退出：先停掉 dsh 子进程，再退出应用。 */
function shutdown() {
  if (quitting) return
  quitting = true
  if (tray) {
    tray.destroy()
    tray = null
  }
  const running = manager && manager.status().running
  const finish = () => {
    disposeIpc()
    app.exit(0)
  }
  if (running) {
    // 最多等 6s，超时强制退出
    const timer = setTimeout(() => finish(), 6000)
    manager
      .stop()
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer)
        finish()
      })
  } else {
    finish()
  }
}

app.whenReady().then(async () => {
  if (!gotLock) return
  settings = new SettingsStore()
  manager = new DshManager()

  // safeStorage 加密凭证层：桌面端自有的敏感值加密存储
  const creds = createCredentialStore(userDataDir())

  // 迁移：把引擎已有的明文 .credentials.yaml 敏感值加密进 safe-credentials（幂等）
  try {
    const { readFileSync, existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { parse } = await import('yaml')
    const credFile = join(manager.home, '.credentials.yaml')
    if (existsSync(credFile)) {
      const parsed = parse(readFileSync(credFile, 'utf8')) as Record<string, unknown>
      const plain: Record<string, string> = {}
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' && v.length > 0) plain[k] = v
        }
      }
      creds.migrateFromPlain(plain)
    }
  } catch {
    // 迁移失败不阻塞
  }

  // 开机自启（若配置过）——开机自动拉起，保证 dsh 引擎随系统启动
  const appearance = settings.get().appearance
  if (appearance?.autoLaunch) {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: Boolean(appearance.launchMinimized),
    })
  }

  setupMenu()
  // Wayland 下 Electron 会自行推断 XDG app id，推断值通常与安装的 .desktop 文件名
  // 不一致，导致 dock/任务栏图标对不上（PR #304 实践）。.desktop 文件名由
  // electron-builder 按 package.json 的 name（dsh-desktop）派生为
  // dsh-desktop.desktop（与 productName "DSH Desktop" 无关），这里显式对齐。
  if (process.platform === 'linux') {
    app.setDesktopName('dsh-desktop.desktop')
  }
  setupUpdater()
  disposeIpc = registerIpc(manager, settings, () => mainWindow, creds)

  createWindow()
  createTray()

  // 启动时最小化到托盘：不展示主窗口，仅后台运行（托盘提供恢复入口）
  if (appearance?.launchMinimized) {
    mainWindow?.hide()
    if (!trayHintShown) {
      trayHintShown = true
      try {
        new Notification({ title: 'DSH Desktop', body: '应用已在后台运行，点托盘鲸鱼图标打开。' }).show()
      } catch {
        // 通知失败不阻塞
      }
    }
  }

  // 后台启动 dsh，就绪后加载官方 UI（引擎端口），失败不阻塞（保留回退屏）
  void manager.start().then((s) => {
    if (s.port) loadEngineUI(s.port, manager.token)
  }).catch((err) => {
    console.error('[dsh-desktop] dsh 启动失败:', err)
  })

  // 端口跟随：引擎崩溃重启换端口 → 窗口重新 loadURL 新端口（A0 端口漂移）
  manager.onStatus((s) => {
    if (s.port && s.ready) loadEngineUI(s.port, manager.token)
    // 崩溃恢复态：引擎已死，窗口回退到本地 React UI（展示恢复页）
    if (s.recovery && !s.ready) {
      loadedEnginePort = null
      if (VITE_DEV_SERVER_URL) {
        void mainWindow?.loadURL(VITE_DEV_SERVER_URL)
      } else {
        void mainWindow?.loadFile(join(app.getAppPath(), 'dist', 'index.html'))
      }
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else mainWindow?.show()
  })
})

app.on('before-quit', (e) => {
  if (!quitting && manager && manager.status().running) {
    e.preventDefault()
    shutdown()
  }
})

// 关闭到托盘后没有窗口也不退出（托盘菜单"退出"才真正退出）
app.on('window-all-closed', () => {
  // 有托盘：保持后台运行（任何平台）
  if (tray) return
  // 无托盘（如开发早期）：非 macOS 退出，macOS 保持（符合惯例）
  if (process.platform !== 'darwin') shutdown()
})

// SIGTERM / SIGINT（进程被外部终止）也要清理 dsh 子进程
process.on('SIGTERM', () => shutdown())
process.on('SIGINT', () => shutdown())

// 兜底：应用退出时确保子进程被终止
app.on('will-quit', () => {
  manager?.stop().catch(() => undefined)
})
