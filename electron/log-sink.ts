/**
 * electron/log-sink.ts —— 主进程落盘日志 sink。
 *
 * 同步写入 userData/logs/ 下按日 + 大小轮转的日志文件，并提供 error 专用流，
 * 便于打包后排查 updater / dsh 启动 / 崩溃等问题（console.* 在打包后不可见）。
 * 借鉴 anywhere-labs/dsh-desktop 的 log-files.ts：日轮转、大小分片、目录总量上限、
 * 符号链接拒绝、UTF-8 安全截断、脱敏。
 */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'info' | 'warn' | 'error'

/** 日志目录总字节上限：超过则按最老优先删除。 */
const MAX_DIR_BYTES = 8 * 1024 * 1024
/** 单文件字节上限：超过则开新分片（.N 后缀）。 */
const MAX_FILE_BYTES = 512 * 1024
/** 单行字节上限：防止异常长行撑爆文件。 */
const MAX_LINE_BYTES = 8192
/** 日志保留天数。 */
const RETAIN_DAYS = 14

const ERROR_SUFFIX = '.error'

/** 简易脱敏：遮蔽常见凭证模式，避免 token / API key / 密码落盘。 */
export function maskSecrets(text: string): string {
  return text
    // Bearer token / Authorization header
    .replace(/(Bearer\s+|authorization:\s*)([A-Za-z0-9._\-+/=]{8,})/gi, (_, p1) => `${p1}***`)
    // ?token=xxx / &token=xxx / token=xxx（URL 与 JSON 中的查询型 token）
    .replace(/([?&]"?token"?\s*[=:]\s*)([^&"\s]+)/gi, (_, p1) => `${p1}***`)
    // "api_key":"xxx" / api-key: xxx
    .replace(/(["']?(?:api[_-]?key|apikey|secret|password|passwd)["']?\s*[=:]\s*["']?)([^"'&,}\s]+)/gi, (_, p1) => `${p1}***`)
    // sk- 开头的 OpenAI/DeepSeek 风格 key
    .replace(/\bsk-[A-Za-z0-9]{8,}/g, 'sk-***')
}

/** 截断到不超出字节上限且不截断在 UTF-8 字符中间。 */
function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf-8')
  if (buf.byteLength <= maxBytes) return text
  // 从 maxBytes 往回退到字符边界
  let cut = maxBytes
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut -= 1
  return buf.subarray(0, cut).toString('utf-8') + '…'
}

/**
 * 落盘日志 sink：按日命名 dsh-YYYY-MM-DD[.error][.N].log，按大小分片，
 * 维护目录总量上限与过期清理。仅用同步 API（quit 处理器里也要能写）。
 */
export class LogFileSink {
  private readonly dir: string
  private currentDate = ''
  private allSegment = 0
  private allBytes = 0
  private errSegment = 0
  private errBytes = 0

  constructor(dir: string) {
    this.dir = dir
    try {
      // 拒绝符号链接目录（防日志投毒 / 写到意外位置）
      if (existsSync(dir)) {
        const st = lstatSync(dir)
        if (st.isSymbolicLink()) throw new Error('log dir is a symlink, refusing')
      } else {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
      }
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      this.rollDate(true)
      this.purgeOlderThan(RETAIN_DAYS)
    } catch {
      // sink 初始化失败不阻塞应用；write 会降级为静默 no-op
      this.dir = ''
    }
  }

  /** 写一行日志到 info/全量 与 error 流。 */
  write(level: LogLevel, rawMessage: string): void {
    if (!this.dir) return
    try {
      this.rollDate(false)
      const ts = new Date().toISOString()
      const line = truncateUtf8(`${ts} [${level.toUpperCase()}] ${maskSecrets(rawMessage)}\n`, MAX_LINE_BYTES)
      this.appendTo('all', line)
      if (level === 'error') this.appendTo('err', line)
    } catch {
      // 落盘失败不能影响主流程
    }
  }

  /** 清空所有日志文件。 */
  clear(): void {
    if (!this.dir) return
    try {
      for (const f of readdirSync(this.dir)) {
        if (f.startsWith('dsh-') && f.endsWith('.log')) {
          try {
            unlinkSync(join(this.dir, f))
          } catch {
            // 忽略
          }
        }
      }
    } catch {
      // 忽略
    }
  }

  // ---- 内部 ----

  private appendTo(kind: 'all' | 'err', line: string): void {
    const isErr = kind === 'err'
    const base = `dsh-${this.currentDate}${isErr ? ERROR_SUFFIX : ''}`
    const seg = isErr ? this.errSegment : this.allSegment
    const name = seg === 0 ? `${base}.log` : `${base}.${seg}.log`
    const path = join(this.dir, name)
    appendFileSync(path, line, { mode: 0o600 })
    const written = Buffer.byteLength(line, 'utf-8')
    if (isErr) this.errBytes += written
    else this.allBytes += written
    // 超过单文件上限：开新分片
    const bytes = isErr ? this.errBytes : this.allBytes
    if (bytes >= MAX_FILE_BYTES) {
      if (isErr) {
        this.errSegment += 1
        this.errBytes = 0
      } else {
        this.allSegment += 1
        this.allBytes = 0
      }
      this.enforceDirectoryCap()
    }
  }

  /** 日期变化时重置分片与字节计数，并从磁盘恢复当日已有分片号。 */
  private rollDate(initial: boolean): void {
    const today = new Date().toISOString().slice(0, 10)
    if (today === this.currentDate) return
    this.currentDate = today
    this.allSegment = this.recoverSegment(`dsh-${today}`)
    this.errSegment = this.recoverSegment(`dsh-${today}${ERROR_SUFFIX}`)
    this.allBytes = 0
    this.errBytes = 0
    if (!initial) this.enforceDirectoryCap()
  }

  /** 扫描日志目录，返回某 base 名已有的最大分片号（无分片返回 0）。 */
  private recoverSegment(base: string): number {
    if (!this.dir) return 0
    try {
      let max = -1
      for (const f of readdirSync(this.dir)) {
        if (f === `${base}.log`) max = Math.max(max, 0)
        else {
          const m = f.match(/^dsh-\d{4}-\d{2}-\d{2}(?:\.error)?\.(\d+)\.log$/)
          if (m && f.startsWith(base)) max = Math.max(max, Number(m[1]))
        }
      }
      return max < 0 ? 0 : max
    } catch {
      return 0
    }
  }

  /** 目录总量超限时按最老优先删除，直到降到上限以下。 */
  private enforceDirectoryCap(): void {
    if (!this.dir) return
    try {
      const files = readdirSync(this.dir)
        .filter((f) => f.startsWith('dsh-') && f.endsWith('.log'))
        .map((f) => {
          const p = join(this.dir, f)
          return { name: f, path: p, mtime: statSync(p).mtimeMs }
        })
        .sort((a, b) => a.mtime - b.mtime)
      let total = files.reduce((sum, f) => sum + statSync(f.path).size, 0)
      for (const f of files) {
        if (total <= MAX_DIR_BYTES) break
        try {
          unlinkSync(f.path)
          total -= statSync(f.path).size
        } catch {
          // 单文件删除失败（如锁定）跳过
        }
      }
    } catch {
      // 忽略
    }
  }

  /** 删除修改时间早于 days 天前的日志。 */
  private purgeOlderThan(days: number): void {
    if (!this.dir) return
    try {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
      for (const f of readdirSync(this.dir)) {
        if (!f.startsWith('dsh-') || !f.endsWith('.log')) continue
        const p = join(this.dir, f)
        if (statSync(p).mtimeMs < cutoff) {
          try {
            unlinkSync(p)
          } catch {
            // 锁定等失败跳过
          }
        }
      }
    } catch {
      // 忽略
    }
  }
}
