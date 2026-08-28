/**
 * electron/settings-store.ts —— 应用级设置持久化（userData 下的 JSON 文件）。
 *
 * 与 dsh 的用户数据分开：dsh 数据在 `userData/dsh-home`，这里只存应用壳自身的
 * 状态（是否完成首启、工作区路径、默认模型）。升级时这些数据不会丢失。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { AppSettings } from '../shared/types.js'

const DEFAULTS: AppSettings = {
  onboarded: false,
  workspaceCwd: null,
  provider: null,
  model: null,
  pinnedSessionIds: [],
  sessionColors: {},
  appearance: {
    theme: 'dark',
    accent: 'deepseek',
    fontSize: 'medium',
    density: 'comfortable',
    autoLaunch: false,
    launchMinimized: false,
  },
}

export class SettingsStore {
  private file: string
  private settings: AppSettings

  constructor() {
    this.file = join(app.getPath('userData'), 'app-settings.json')
    this.settings = { ...DEFAULTS, ...this.read() }
  }

  /**
   * 读取设置文件。损坏时隔离成 .broken-<ts> 后用默认值继续（不崩溃）。
   * 借鉴 dsh_desktop 的 settings 损坏自愈：坏 JSON → 隔离 .broken → 从空配置继续。
   */
  private read(): Partial<AppSettings> {
    if (!existsSync(this.file)) return {}
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Partial<AppSettings>
    } catch {
      // 文件损坏 → 隔离成 .broken-<ts>，避免反复解析失败
      const broken = `${this.file}.broken-${Date.now()}`
      try {
        renameSync(this.file, broken)
        console.warn(`[harness-desktop] 设置文件损坏，已隔离到 ${broken}，使用默认值继续`)
      } catch {
        // 隔离失败不阻断（尽力而为）
      }
      return {}
    }
  }

  private write() {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.settings, null, 2), 'utf8')
    } catch {
      // 写失败不致命，忽略
    }
  }

  get(): AppSettings {
    return { ...this.settings }
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.settings = { ...this.settings, ...patch }
    this.write()
    return this.get()
  }
}
