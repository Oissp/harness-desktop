/**
 * src/__tests__/contract.test.ts —— IPC 契约防漂移测试（机器强制）。
 *
 * 借鉴 dsh_desktop 的契约审计测试（no_extra_commands_beyond_contract）：
 * 三层 IPC 边界（shared/types.ts → preload.ts → ipc.ts）必须 lockstep，
 * 任何一层漂移（改名/漏注册/漏暴露）都让本测试红。
 *
 * 检查项：
 *  1. HarnessApi 接口声明的每个方法 → preload 的 api 对象都有对应绑定
 *  2. preload 调用的每个 IPC channel → ipc.ts/main.ts 都有 ipcMain.handle 注册
 *  3. ipc.ts 注册的每个 channel → preload 中都有调用者（或属于已知内部通道）
 *
 * 历史教训（对齐参考项目）：file_open 曾注册成 open_path 而契约调 file_open——
 * 正是此类审计测试抓住的漂移。先改契约再写代码是流程防线。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')

const typesSrc = readFileSync(join(ROOT, 'shared', 'types.ts'), 'utf8')
const preloadSrc = readFileSync(join(ROOT, 'electron', 'preload.ts'), 'utf8')
const ipcSrc = readFileSync(join(ROOT, 'electron', 'ipc.ts'), 'utf8')
const mainSrc = readFileSync(join(ROOT, 'electron', 'main.ts'), 'utf8')

/** 从 shared/types.ts 的 HarnessApi 接口提取方法名（处理嵌套大括号）。 */
function extractHarnessApiMethods(): string[] {
  const startIdx = typesSrc.indexOf('export interface HarnessApi {')
  if (startIdx === -1) throw new Error('未找到 HarnessApi 接口')
  // 从 { 开始数大括号深度，找到匹配的闭合 }
  let depth = 0
  let bodyStart = -1
  let bodyEnd = -1
  for (let i = startIdx; i < typesSrc.length; i++) {
    if (typesSrc[i] === '{') {
      if (depth === 0) bodyStart = i + 1
      depth++
    } else if (typesSrc[i] === '}') {
      depth--
      if (depth === 0) {
        bodyEnd = i
        break
      }
    }
  }
  if (bodyStart === -1 || bodyEnd === -1) throw new Error('HarnessApi 接口大括号不匹配')
  const body = typesSrc.slice(bodyStart, bodyEnd)
  // 匹配方法签名：行首可选空格 + 方法名 + ( 或 :（属性签名）
  const methods = [...body.matchAll(/^\s*(\w+)\s*[\(:]/gm)].map((m) => m[1])
  return methods
}

/**
 * 从 HarnessApi 方法名中筛出事件监听方法（on* 返回 () => void，不走 call()）。
 * 这些方法用 ipcRenderer.on 订阅事件，不经过 ipcMain.handle，单独校验。
 */
function isEventListenerMethod(name: string): boolean {
  return name.startsWith('on') && name.length > 2 && name[2] === name[2].toUpperCase()
}

/** 从 preload.ts 提取 api 对象的方法名 → IPC channel 映射。 */
function extractPreloadApiMap(): Map<string, string> {
  const map = new Map<string, string>()
  // 匹配 methodName: (...) => call('channel' 或 methodName: () => call('channel'
  const re = /^\s*(\w+):\s*\([^)]*\)\s*=>\s*call\(['"]([\w:-]+)['"]/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(preloadSrc)) !== null) {
    map.set(m[1], m[2])
  }
  return map
}

/** 从 preload.ts 提取所有被调用的 IPC channel（call + ipcRenderer.invoke）。 */
function extractPreloadChannels(): Set<string> {
  const channels = new Set<string>()
  // call('channel') 或 call<number>('channel')
  for (const m of preloadSrc.matchAll(/call(?:<[^>]*>)?\(\s*['"]([\w:-]+)['"]/g)) {
    channels.add(m[1])
  }
  // ipcRenderer.invoke('channel')
  for (const m of preloadSrc.matchAll(/ipcRenderer\.invoke\(\s*['"]([\w:-]+)['"]/g)) {
    channels.add(m[1])
  }
  return channels
}

/** 从 ipc.ts + main.ts 提取所有 ipcMain.handle 注册的 channel。 */
function extractIpcChannels(): Set<string> {
  const channels = new Set<string>()
  for (const src of [ipcSrc, mainSrc]) {
    for (const m of src.matchAll(/ipcMain\.handle\(\s*['"]([\w:-]+)['"]/g)) {
      channels.add(m[1])
    }
  }
  return channels
}

describe('IPC 契约防漂移（三层 lockstep 机器强制）', () => {
  const apiMethods = extractHarnessApiMethods()
  const preloadApiMap = extractPreloadApiMap()
  const preloadChannels = extractPreloadChannels()
  const ipcChannels = extractIpcChannels()

  it('HarnessApi 接口提取到方法', () => {
    expect(apiMethods.length).toBeGreaterThan(10)
  })

  it('HarnessApi 每个非事件方法在 preload api 对象中都有 call() 绑定', () => {
    const callMethods = apiMethods.filter((m) => !isEventListenerMethod(m))
    const missing = callMethods.filter((m) => !preloadApiMap.has(m))
    expect(missing, `HarnessApi 方法在 preload 中缺失 call() 绑定: ${missing.join(', ')}`).toEqual([])
  })

  it('HarnessApi 每个事件方法(on*)在 preload 中都有 ipcRenderer.on 绑定', () => {
    const eventMethods = apiMethods.filter(isEventListenerMethod)
    const missing = eventMethods.filter((m) => !preloadSrc.includes(`${m}:`))
    expect(missing, `事件方法在 preload 中缺失: ${missing.join(', ')}`).toEqual([])
  })

  it('preload api 对象的每个方法都在 HarnessApi 接口中声明', () => {
    const extra = [...preloadApiMap.keys()].filter((k) => !apiMethods.includes(k))
    expect(extra, `preload 暴露了 HarnessApi 未声明的方法: ${extra.join(', ')}`).toEqual([])
  })

  it('preload 调用的每个 channel 都有 ipcMain.handle 注册', () => {
    const missing = [...preloadChannels].filter((c) => !ipcChannels.has(c))
    expect(missing, `preload 调用了未注册的 IPC channel: ${missing.join(', ')}`).toEqual([])
  })

  it('ipc.ts 注册的每个 channel 都有 preload 调用者（或属于已知内部通道）', () => {
    // 已知内部通道：不在 preload 中调用但合法的通道
    const internalChannels = new Set<string>()
    // dsh:subscribe 由 onSessionEvent 内部 ipcRenderer.invoke 调用（已在 preloadChannels 中）
    const orphaned = [...ipcChannels].filter((c) => !preloadChannels.has(c) && !internalChannels.has(c))
    expect(orphaned, `ipc.ts 注册了无调用者的孤儿 channel: ${orphaned.join(', ')}`).toEqual([])
  })
})
