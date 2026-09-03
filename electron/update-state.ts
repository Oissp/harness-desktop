/**
 * electron/update-state.ts —— 更新状态的持久化（按版本去重后台提示）。
 *
 * 借鉴 anywhere-labs/dsh-desktop 的 update-lifecycle.ts：后台检查发现新版本时
 * 按版本持久化"已提示"标记，同一版本只通知一次，避免每 6h 重复打扰。
 * 文件 userData/update-state.json，4KB 上限，原子写（tmp+rename），0o600 权限。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

interface UpdateStateData {
  /** 已通知过的版本号（后台提示去重）。 */
  lastNotifiedVersion?: string | null
}

const MAX_READ_BYTES = 4096

export class UpdateStateStore {
  private readonly file: string
  private data: UpdateStateData

  constructor() {
    this.file = join(app.getPath('userData'), 'update-state.json')
    this.data = this.read()
  }

  /** 最近已后台通知的版本号（null 表示从未）。 */
  getLastNotifiedVersion(): string | null {
    return this.data.lastNotifiedVersion ?? null
  }

  /** 记录已通知版本，持久化。 */
  setLastNotifiedVersion(version: string | null): void {
    this.data.lastNotifiedVersion = version
    this.write()
  }

  private read(): UpdateStateData {
    if (!existsSync(this.file)) return {}
    try {
      const raw = readFileSync(this.file, 'utf8')
      if (Buffer.byteLength(raw, 'utf-8') > MAX_READ_BYTES) return {}
      const parsed = JSON.parse(raw) as UpdateStateData
      return typeof parsed === 'object' && parsed !== null ? parsed : {}
    } catch {
      // 损坏 / 瞬时错误：用空状态继续，不隔离（下次写会覆盖）
      return {}
    }
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch {
      // 写失败不阻塞更新流程
    }
  }
}
