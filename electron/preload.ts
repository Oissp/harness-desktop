/**
 * electron/preload.ts —— 暴露安全的 IPC API 给 renderer。
 */
/// <reference lib="dom" />
import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  ArchivedSessionInfo,
  CustomProviderConfig,
  DshStatus,
  HarnessApi,
  IpcResult,
  PickedFile,
  Reminder,
  SessionStreamEvent,
  WebSearchConfig,
} from '../shared/types.js'

const call = <T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> =>
  ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<T>>

const api: HarnessApi = {
  getAppState: () => call('app:getState'),
  updateAppSettings: (patch: Partial<AppSettings>) => call('app:updateSettings', patch),
  setAutoLaunch: (enabled: boolean) => call('app:setAutoLaunch', enabled),
  checkForUpdates: () => call('update:check'),
  quitAndInstall: () => call('update:quitAndInstall'),
  getDshStatus: () => call('dsh:status'),
  ensureDsh: () => call('dsh:ensure'),
  shutdownDsh: () => call('dsh:shutdown'),
  restartDsh: () => call('dsh:restart'),
  describe: () => call('dsh:describe'),

  listSessions: () => call('session:list'),
  createSession: (cwd?: string, agentPreset?: string) => call('session:create', cwd, agentPreset),
  getHistory: (sessionId: string) => call('session:history', sessionId),
  sendMessage: (sessionId: string, text: string, files?: PickedFile[]) => call('session:send', sessionId, text, files),
  cancelTurn: (sessionId: string) => call('session:cancel', sessionId),
  renameSession: (sessionId: string, title: string) => call('session:rename', sessionId, title),
  forkSession: (sessionId: string) => call('session:fork', sessionId),
  archiveSession: (sessionId: string) => call('session:archive', sessionId),
  hardDeleteSession: (sessionId: string, cwd?: string) => call('session:hardDelete', sessionId, cwd),
  listArchivedSessions: () => call('session:listArchived'),
  copyText: (text: string) => call('clipboard:copy', text),

  listAgentPresets: () => call('preset:list'),
  selectAgentPreset: (sessionId: string, agentPreset: string) => call('preset:select', sessionId, agentPreset),
  pickFiles: () => call('files:pick'),

  listModels: () => call('model:list'),
  listProviders: () => call('model:providers'),
  selectModel: (sessionId: string, provider: string, model: string) =>
    call('model:select', sessionId, provider, model),

  listCustomProviders: () => call('provider:list'),
  saveCustomProvider: (config: CustomProviderConfig) => call('provider:save', config),
  removeCustomProvider: (id: string) => call('provider:remove', id),
  setProviderApiKey: (apiKeyEnv: string, key: string) => call('provider:setKey', apiKeyEnv, key),

  setApiKey: (key: string) => call('cred:setKey', key),
  hasApiKey: () => call('cred:hasKey'),
  testApiKey: (key: string) => call('cred:testKey', key),
  pickDirectory: () => call('dir:pick'),

  listCredentials: () => call('cred:list'),
  setCredential: (ref: string, value: string) => call('cred:setRef', ref, value),
  clearCredential: (ref: string) => call('cred:clear', ref),
  listReminders: () => call('reminder:list'),
  createReminder: (input: Omit<Reminder, 'id' | 'nextAt'>) => call('reminder:create', input),
  deleteReminder: (id: string) => call('reminder:delete', id),
  listMemories: () => call('memory:list'),
  addMemory: (text: string, tags?: string[]) => call('memory:add', text, tags),
  deleteMemory: (id: string) => call('memory:delete', id),
  clearMemories: () => call('memory:clear'),
  togglePlanMode: (sessionId: string) => call('plan:toggle', sessionId),
  getWebSearchConfig: () => call('websearch:get'),
  setWebSearchConfig: (config: Partial<WebSearchConfig>) => call('websearch:set', config),
  exportSession: (sessionId: string, format: 'zip' | 'json' | 'markdown') => call('session:export', sessionId, format),
  listSkills: (sessionId: string) => call('skill:list', sessionId),

  onSessionEvent: (cb: (evt: SessionStreamEvent) => void) => {
    const listener = (_e: unknown, evt: SessionStreamEvent) => cb(evt)
    ipcRenderer.on('dsh:event', listener)
    void ipcRenderer.invoke('dsh:subscribe')
    return () => ipcRenderer.removeListener('dsh:event', listener)
  },
  onMenuEvent: (cb: (action: 'new-chat' | 'open-settings') => void) => {
    const onNew = () => cb('new-chat')
    const onSettings = () => cb('open-settings')
    ipcRenderer.on('menu:new-chat', onNew)
    ipcRenderer.on('menu:open-settings', onSettings)
    return () => {
      ipcRenderer.removeListener('menu:new-chat', onNew)
      ipcRenderer.removeListener('menu:open-settings', onSettings)
    }
  },
  onReminderFired: (cb: (payload: { sessionId: string; text: string }) => void) => {
    const listener = (_e: unknown, payload: { sessionId: string; text: string }) => cb(payload)
    ipcRenderer.on('reminder:fired', listener)
    return () => ipcRenderer.removeListener('reminder:fired', listener)
  },
  onDshStatus: (cb: (status: DshStatus) => void) => {
    const listener = (_e: unknown, status: DshStatus) => cb(status)
    ipcRenderer.on('dsh:status', listener)
    return () => ipcRenderer.removeListener('dsh:status', listener)
  },
  onUpdateStatus: (cb: (status: { state: string; version?: string; percent?: number; message?: string }) => void) => {
    const listener = (_e: unknown, status: { state: string; version?: string; percent?: number; message?: string }) =>
      cb(status)
    ipcRenderer.on('update:status', listener)
    return () => ipcRenderer.removeListener('update:status', listener)
  },
}

contextBridge.exposeInMainWorld('harness', api)

// ---- 026 __desktop__ 桥：官方 UI 页面消费的桌面壳能力 ----
interface DesktopBridge {
  getPort(): Promise<number | null>
  getVersion(): Promise<string>
  notify(title: string, body: string): Promise<void>
  /** 归档会话列表（含本地缓存的标题/cwd 元数据合并）。 */
  listArchived(): Promise<ArchivedSessionInfo[]>
  /** 硬删除会话（连同磁盘目录）。 */
  hardDeleteSession(sessionId: string, cwd?: string): Promise<boolean>
  /** 在只读窗口打开归档会话，查看其历史内容。 */
  openArchiveViewer(sessionId: string, title?: string): Promise<void>
  onEnginePort(cb: (port: number | null) => void): () => void
  onMenuEvent(cb: (action: 'new-chat' | 'open-settings') => void): () => void
}

const desktop: DesktopBridge = {
  getPort: async () => {
    const res = await call<number | null>('desktop:getPort')
    return res.ok ? (res.value ?? null) : null
  },
  getVersion: async () => {
    const res = await call<string>('desktop:getVersion')
    return res.ok ? (res.value ?? '') : ''
  },
  notify: async (title, body) => {
    await call('desktop:notify', title, body)
  },
  // 归档列表：dsh baseline 只给 sessionId + cwd，标题归档后无处可查，
  // 故与桌面侧本地缓存的 archivedSessionMeta 合并（与桌面 UI 同一套数据）。
  listArchived: async () => {
    const [listRes, stateRes] = await Promise.all([
      call<ArchivedSessionInfo[]>('session:listArchived'),
      call<{ settings?: AppSettings }>('app:getState'),
    ])
    if (!listRes.ok) return []
    const meta = stateRes.ok ? stateRes.value?.settings?.archivedSessionMeta : undefined
    const reviewId = stateRes.ok ? stateRes.value?.settings?.reviewSessionId : undefined
    return (listRes.value ?? [])
      .filter((s) => s.sessionId !== reviewId)
      .map((s) => {
        const m = meta?.[s.sessionId]
        return { sessionId: s.sessionId, title: m?.title, cwd: s.cwd ?? m?.cwd, archivedAt: m?.archivedAt }
      })
  },
  hardDeleteSession: async (sessionId, cwd) => {
    const res = await call('session:hardDelete', sessionId, cwd)
    return res.ok
  },
  openArchiveViewer: async (sessionId, title) => {
    await call('desktop:openArchiveViewer', sessionId, title)
  },
  onEnginePort: (cb) => {
    const listener = (_e: unknown, status: DshStatus) => {
      cb(status?.port ?? null)
    }
    ipcRenderer.on('dsh:status', listener)
    return () => ipcRenderer.removeListener('dsh:status', listener)
  },
  onMenuEvent: (cb) => {
    const onNew = () => cb('new-chat')
    const onSettings = () => cb('open-settings')
    ipcRenderer.on('menu:new-chat', onNew)
    ipcRenderer.on('menu:open-settings', onSettings)
    return () => {
      ipcRenderer.removeListener('menu:new-chat', onNew)
      ipcRenderer.removeListener('menu:open-settings', onSettings)
    }
  },
}

contextBridge.exposeInMainWorld('__desktop__', desktop)

// ---- 品牌注入（官方 UI 页面）：渐变流动鲸鱼 + "harness desktop vX" ----
// 目标区域：① 窗口右上角（fixed 定位，任何页面可见）
//          ② 首次会话 hero（替换官方"探索未至之境 预览版"区）
// 动态变色 = SMIL 渐变 stop 颜色/位置循环（蓝→紫→粉），纯浏览器动画，无 JS 定时器
const BRAND_WHALE_PATH =
  'M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z'

/** 渐变流动鲸鱼 SVG（SMIL 动画：stop 颜色 + 位置循环 蓝→紫→粉）。 */
function brandWhaleSvg(size: number, gradId: string): string {
  return (
    '<svg width="' + size + '" height="' + size + '" viewBox="0 0 50 50" fill="none" aria-hidden="true">' +
    '<defs><linearGradient id="' + gradId + '" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%">' +
    '<animate attributeName="stop-color" values="#4f8cff;#a855f7;#ec4899;#4f8cff" dur="6s" repeatCount="indefinite"/>' +
    '<animate attributeName="offset" values="0%;0.5;0.95;0%" dur="6s" repeatCount="indefinite"/>' +
    '</stop>' +
    '<stop offset="50%"><animate attributeName="stop-color" values="#a855f7;#ec4899;#4f8cff;#a855f7" dur="6s" repeatCount="indefinite"/></stop>' +
    '<stop offset="100%"><animate attributeName="stop-color" values="#ec4899;#4f8cff;#a855f7;#ec4899" dur="6s" repeatCount="indefinite"/></stop>' +
    '</linearGradient></defs>' +
    '<path d="' + BRAND_WHALE_PATH + '" fill="url(#' + gradId + ')"/></svg>'
  )
}

/** 品牌注入（官方 UI 页面）：左上角品牌替换 + 首次会话 hero 替换。 */
function injectDesktopBrand() {
  const started = Date.now()

  /**
   * 动态解析品牌文字颜色：读取侧栏/文档背景亮度。
   * 浅色主题（背景亮）→ 深色文字（黑）；深色主题 → 浅色文字（白），保证反差。
   */
  const resolveBrandColors = (): { primary: string; secondary: string } => {
    const bg = (() => {
      const sidebar = document.querySelector('[class*="sidebarCol"], [class*="sidebar"]')
      const probe = sidebar ?? document.body
      if (!probe) return '#0f1115'
      const style = getComputedStyle(probe)
      const rgb = style.backgroundColor
      const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(rgb)
      if (m) {
        const lum = (Number(m[1]) * 0.299 + Number(m[2]) * 0.587 + Number(m[3]) * 0.114)
        return lum > 140 ? 'light' : 'dark'
      }
      return 'dark'
    })()
    if (bg === 'light') return { primary: '#111418', secondary: '#5a6472' }
    return { primary: '#e8eaf1', secondary: '#9aa3b2' }
  }

  /** hero 版本徽标：浅色界面蓝底白字；深色界面白底深字（反差）。 */
  const heroVersionBadge = (): { style: string; dataAttr: string } => {
    const { primary } = resolveBrandColors()
    const isLight = primary === '#111418'
    const badgeStyle = isLight
      ? 'display:inline-block;margin-left:10px;background:#4f8cff;color:#fff;font:600 13px/1.4 -apple-system,&quot;Segoe UI&quot;,Roboto,sans-serif;border-radius:999px;padding:3px 10px;vertical-align:middle;'
      : 'display:inline-block;margin-left:10px;background:#fff;color:#111418;font:600 13px/1.4 -apple-system,&quot;Segoe UI&quot;,Roboto,sans-serif;border-radius:999px;padding:3px 10px;vertical-align:middle;'
    return { style: badgeStyle, dataAttr: 'data-hd-hero-ver' }
  }

  /** hero 品牌：居中排版（大鲸鱼 + 标题 + 版本徽标 + 副标题）。 */
  const makeHeroBrand = (): HTMLElement => {
    const { primary, secondary } = resolveBrandColors()
    const ver = heroVersionBadge()
    const el = document.createElement('div')
    el.setAttribute('data-hd-hero-brand', '1')
    el.style.cssText =
      'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:12px 0;width:100%;'
    el.innerHTML =
      brandWhaleSvg(56, 'hd-hero-grad') +
      '<span data-hd-hero-title style="font:700 30px/1.2 -apple-system,&quot;Segoe UI&quot;,Roboto,sans-serif;color:' +
      primary +
      ';letter-spacing:.3px">DSH Desktop <span ' +
      ver.dataAttr +
      ' style="' +
      ver.style +
      '>v1.0.1</span></span>' +
      '<span data-hd-hero-sub style="font:400 14px/1.5 -apple-system,&quot;Segoe UI&quot;,Roboto,sans-serif;color:' +
      secondary +
      '">你的 AI 工作台 · 开始对话</span>'
    return el
  }

  const applyVersion = () => {
    // hero 版本徽标用 getVersion 填充（默认 v1.0.1）
    void desktop.getVersion().then((v) => {
      const heroVer = document.querySelector('[data-hd-hero-ver]')
      if (heroVer) heroVer.textContent = 'v' + (v || '1.0.1')
    })
  }

  /** hero 品牌替换的目标文本（多语言兜底：中文/英文/未就绪的 key）。 */
  const HERO_HEADLINE_KEYS = ['探索未至', 'Into the Unknown', 'hero.headline']

  /**
   * 找官方 hero 的 .headline 容器并替换为品牌。
   * 三层匹配：
   *  C) CSS Modules 结构：`[class*="_headline_"]`（原类名保留在 hash 中，不依赖 locale）
   *  B) 文本匹配：中文/英文/未就绪 key
   *  校验父级含 fish 特征（子元素有 svg），避免误替换。
   */
  const ensureHero = () => {
    if (!document.body) return
    // 已注入标记：跳过
    if (document.querySelector('[data-hd-hero-brand]')) return
    // 方案 C：结构匹配 headline 容器 → 取祖先 stack（更宽、CSS 居中，品牌 column 排版自然生效）
    const headlineEls = Array.from(document.querySelectorAll('[class*="_headline_"]'))
    for (const headline of headlineEls) {
      const text = (headline.textContent ?? '').trim()
      const hasHeroText = HERO_HEADLINE_KEYS.some((k) => text.indexOf(k) !== -1)
      const hasFish = headline.querySelector('svg') !== null || headline.closest('[class*="_fish_"]') !== null
      if (hasHeroText || hasFish) {
        // 用 headline 的父 stack 容器（headline.parentElement 即 stack，宽、CSS 居中）
        // 避免 closest 匹配到 headline 自身（若其 class 意外含 _stack_）
        let target: HTMLElement | null = headline.parentElement
        if (target && target !== headline && target.classList) {
          // 确认 target 是 stack 或更宽容器
          if (target.querySelector && !target.querySelector('[data-hd-hero-brand]')) {
            target.innerHTML = ''
            target.appendChild(makeHeroBrand())
            applyVersion()
            return
          }
        }
      }
    }
    // 方案 B：文本匹配（兜底，用于结构类名变动时）
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const text = node.textContent ?? ''
      if (HERO_HEADLINE_KEYS.some((k) => text.indexOf(k) !== -1)) {
        const textEl = node.parentElement
        const headline = textEl ? textEl.parentElement : null
        if (headline && headline.parentElement && !headline.querySelector('[data-hd-hero-brand]')) {
          const target = headline.parentElement
          if (target && !target.querySelector('[data-hd-hero-brand]')) {
            target.innerHTML = ''
            target.appendChild(makeHeroBrand())
            applyVersion()
            return
          }
        }
      }
    }
  }

  const boot = () => {
    ensureHero()
    // React 重渲染可能恢复官方 hero → MutationObserver 持续兜底重注入（节流）
    // characterData: true —— locale 就绪后 hero 文本从 key/英文变中文是 characterData 变更
    let lastScan = 0
    const mo = new MutationObserver(() => {
      const now = Date.now()
      if (now - lastScan < 300) return
      lastScan = now
      ensureHero()
    })
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    // 兜底轮询：hero 延迟渲染时也能命中（30s 后停止）
    const poll = () => {
      if (Date.now() - started > 30000) return
      ensureHero()
      setTimeout(poll, 400)
    }
    setTimeout(poll, 400)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true })
  } else {
    boot()
  }
}

/**
 * 归档分组注入（官方 UI 页面）：官方 UI 无归档概念，桌面侧的归档会话
 * 在官方 UI 下无处可看（桌面 React 侧栏仅启动/回退屏可见）。这里在官方
 * 侧栏底部注入一个可折叠的"归档"分组，复用 __desktop__ 桥的归档 API。
 *
 * 定位策略：不依赖官方的 CSS Modules hash 类名（构建期变动），改用结构特征——
 * 找页面里最高最窄的垂直滚动容器（即会话列表侧栏），把面板插到其末尾。
 */
function injectArchivedPanel() {
  const PANEL_ATTR = 'data-hd-archived-panel'
  let collapsed = true
  let cache: ArchivedSessionInfo[] = []
  let pendingDelete: string | null = null

  /** 判断颜色主题（与品牌注入同一套亮度探测）。 */
  const isDark = () => !document.body?.hasAttribute('data-ds-light-theme') &&
    (document.body?.hasAttribute('data-ds-dark-theme') ||
      (() => {
        const s = document.body ? getComputedStyle(document.body).backgroundColor : ''
        const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(s)
        if (!m) return true
        return Number(m[1]) * 0.299 + Number(m[2]) * 0.587 + Number(m[3]) * 0.114 <= 140
      })())

  const colors = () =>
    isDark()
      ? { fg: '#e8eaf1', dim: '#9aa3b2', border: 'rgb(255 255 255 / 12%)', hover: 'rgb(255 255 255 / 6%)', danger: '#ff6b6b' }
      : { fg: '#111418', dim: '#5a6472', border: 'rgb(0 0 0 / 10%)', hover: 'rgb(0 0 0 / 5%)', danger: '#d93a3a' }

  /**
   * 找官方侧栏容器：页面内可见、宽度 180–420px、高度占视口大半的垂直容器。
   * 取最深的匹配（最贴近列表本体），避免命中外层布局壳。
   */
  const findSidebar = (): HTMLElement | null => {
    const vh = window.innerHeight
    let best: HTMLElement | null = null
    let bestDepth = -1
    const all = document.body ? document.body.querySelectorAll('*') : []
    for (const el of Array.from(all) as HTMLElement[]) {
      const r = el.getBoundingClientRect()
      if (r.width < 180 || r.width > 420) continue
      if (r.height < vh * 0.5) continue
      if (r.left > 120) continue // 侧栏贴左
      let depth = 0
      for (let p = el.parentElement; p; p = p.parentElement) depth++
      if (depth > bestDepth) {
        best = el
        bestDepth = depth
      }
    }
    return best
  }

  const makeRow = (s: ArchivedSessionInfo): HTMLElement => {
    const c = colors()
    const row = document.createElement('div')
    row.style.cssText =
      'display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;font:400 12px/1.4 -apple-system,"Segoe UI",Roboto,sans-serif;color:' +
      c.dim + ';cursor:pointer'
    row.onmouseenter = () => (row.style.background = c.hover)
    row.onmouseleave = () => (row.style.background = 'transparent')
    row.onclick = () => {
      void desktop.openArchiveViewer(s.sessionId, s.title || undefined)
    }

    const title = document.createElement('span')
    title.textContent = s.title || '归档会话 ' + s.sessionId.slice(8, 14)
    title.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    title.title = (s.title || s.sessionId) + (s.cwd ? '\n' + s.cwd : '') + '\n点击查看会话内容'
    row.appendChild(title)

    if (pendingDelete === s.sessionId) {
      const confirm = document.createElement('span')
      confirm.textContent = '确认删除？'
      confirm.style.cssText = 'font-size:11px;color:' + c.danger
      const yes = document.createElement('button')
      yes.textContent = '删除'
      yes.style.cssText =
        'background:none;border:none;cursor:pointer;font-size:11px;padding:1px 4px;color:' + c.danger
      yes.onclick = (e) => {
        e.stopPropagation()
        void desktop.hardDeleteSession(s.sessionId, s.cwd).then(() => {
          pendingDelete = null
          void refresh()
        })
      }
      const no = document.createElement('button')
      no.textContent = '取消'
      no.style.cssText = 'background:none;border:none;cursor:pointer;font-size:11px;padding:1px 4px;color:' + c.dim
      no.onclick = (e) => {
        e.stopPropagation()
        pendingDelete = null
        render()
      }
      row.appendChild(confirm)
      row.appendChild(yes)
      row.appendChild(no)
    } else {
      const del = document.createElement('button')
      del.textContent = '✕'
      del.title = '彻底删除（含磁盘目录）'
      del.style.cssText =
        'background:none;border:none;cursor:pointer;font-size:11px;padding:1px 4px;opacity:.6;color:' + c.dim
      del.onclick = (e) => {
        e.stopPropagation()
        pendingDelete = s.sessionId
        render()
      }
      row.appendChild(del)
    }
    return row
  }

  /** 渲染面板内容到已挂载的容器（不重新定位）。 */
  const render = () => {
    const panel = document.querySelector('[' + PANEL_ATTR + ']') as HTMLElement | null
    if (!panel) return
    const c = colors()
    panel.innerHTML = ''
    if (cache.length === 0) return // 无归档会话：不占位

    const header = document.createElement('button')
    header.style.cssText =
      'display:flex;align-items:center;gap:6px;width:100%;background:none;border:none;cursor:pointer;padding:6px 8px;font:500 12px/1.4 -apple-system,"Segoe UI",Roboto,sans-serif;color:' +
      c.dim
    header.title = collapsed ? '展开归档会话' : '收起归档会话'
    header.onclick = () => {
      collapsed = !collapsed
      pendingDelete = null
      render()
    }
    const caret = document.createElement('span')
    caret.textContent = collapsed ? '▸' : '▾'
    const label = document.createElement('span')
    label.textContent = '归档'
    label.style.flex = '1'
    label.style.textAlign = 'left'
    const count = document.createElement('span')
    count.textContent = String(cache.length)
    count.style.cssText = 'opacity:.7;font-variant-numeric:tabular-nums'
    header.appendChild(caret)
    header.appendChild(label)
    header.appendChild(count)
    panel.appendChild(header)

    if (!collapsed) {
      const list = document.createElement('div')
      list.style.cssText = 'display:flex;flex-direction:column;gap:1px;max-height:40vh;overflow-y:auto;padding-bottom:4px'
      for (const s of cache) list.appendChild(makeRow(s))
      panel.appendChild(list)
    }
  }

  /** 拉取归档列表并渲染。 */
  const refresh = async () => {
    cache = await desktop.listArchived()
    render()
  }

  /** 确保面板已挂载在侧栏末尾；侧栏容器变化或面板脱离时重新挂到当前最佳侧栏。 */
  const ensurePanel = () => {
    const sidebar = findSidebar()
    if (!sidebar) return
    const existing = document.querySelector('[' + PANEL_ATTR + ']') as HTMLElement | null
    // 已挂在正确的侧栏末尾：跳过。否则（首次、React 重渲染换掉旧容器、或初载命中了错误容器）
    // 一律（重新）追加到当前最佳侧栏末尾——appendChild 会先把已有节点从旧父级摘下再挂回。
    if (existing && existing.isConnected && existing.parentElement === sidebar && sidebar.lastElementChild === existing) return
    const c = colors()
    let panel = existing
    if (!panel || !panel.isConnected) {
      panel = document.createElement('div')
      panel.setAttribute(PANEL_ATTR, '1')
    }
    panel.style.cssText =
      'flex:0 0 auto;margin:4px 6px 6px;padding-top:6px;border-top:1px solid ' + c.border
    sidebar.appendChild(panel)
    render()
  }

  const boot = () => {
    void refresh()
    // 延迟初次挂载：等侧栏 DOM 稳定后再挂，避免页面加载早期 findSidebar 命中错误容器
    setTimeout(() => ensurePanel(), 500)
    setTimeout(() => ensurePanel(), 1500)
    // 诊断：侧栏探测与挂载结果。findSidebar 是结构启发式（官方 UI 类名为构建期
    // hash，不可依赖），上游改版可能致探测失败 —— 排查时开 DevTools 看这行。
    if (process.env.HD_ARCHIVED_DEBUG) {
      const report = () => {
        const sb = findSidebar()
        const r = sb ? sb.getBoundingClientRect() : null
        console.log(
          '[hd-archived] sidebar=' +
            (sb
              ? sb.tagName + '.' + String(sb.className).slice(0, 60) + ' ' + Math.round(r!.width) + 'x' + Math.round(r!.height) + ' @left=' + Math.round(r!.left)
              : 'NOT_FOUND') +
            ' mounted=' + Boolean(document.querySelector('[' + PANEL_ATTR + ']')?.isConnected) +
            ' archived=' + cache.length,
        )
      }
      setTimeout(report, 3000)
      setTimeout(report, 8000)
    }
    // React 重渲染会移除注入节点 → MutationObserver 兜底重挂（节流）
    let lastScan = 0
    const mo = new MutationObserver(() => {
      const now = Date.now()
      if (now - lastScan < 400) return
      lastScan = now
      ensurePanel()
    })
    mo.observe(document.documentElement, { childList: true, subtree: true })
    // 归档集合变化（在官方 UI 里归档会话）无事件回流，定期轻量复查
    setInterval(() => void refresh(), 10_000)
    // 暴露刷新接口：归档窗口关闭时触发立即刷新（标题回写后更新列表显示）
    ;(window as { __hd_refreshArchived?: () => Promise<void> }).__hd_refreshArchived = refresh
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true })
  } else {
    boot()
  }
}

injectDesktopBrand()
injectArchivedPanel()