/**
 * electron/desktop-logger.ts —— 主进程日志器 + 崩溃 / 子进程异常捕获。
 *
 * 包装 LogFileSink，镜像到 stderr（dev 可见），并安装 uncaughtException 与
 * Electron child-process-gone 钩子，把崩溃现场落盘后再退出。借鉴
 * anywhere-labs/dsh-desktop 的 desktop-logger.ts。
 */
import type { App } from 'electron'
import type { LogFileSink, LogLevel } from './log-sink.ts'

export interface DesktopLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  /** 归一化未知 cause（Error / 对象 / 字符串）后记 error。 */
  errorCause(cause: unknown): void
}

/** dev 兜底：仅写 stderr，无落盘。 */
class ConsoleLogger implements DesktopLogger {
  info(message: string): void {
    process.stderr.write(`[INFO] ${message}\n`)
  }
  warn(message: string): void {
    process.stderr.write(`[WARN] ${message}\n`)
  }
  error(message: string): void {
    process.stderr.write(`[ERROR] ${message}\n`)
  }
  errorCause(cause: unknown): void {
    this.error(cause instanceof Error ? cause.stack ?? cause.message : String(cause))
  }
}

/** 全局 logger 实例：main.ts 在 app.whenReady 前尽早赋值，崩溃处理器依赖它。 */
let activeLogger: DesktopLogger = new ConsoleLogger()

/** 取全局 logger（崩溃处理器在 ready 前可能触发，需有兜底）。 */
export function getLogger(): DesktopLogger {
  return activeLogger
}

/** 设置全局 logger（main.ts 启动时调用）。 */
export function setLogger(logger: DesktopLogger): void {
  activeLogger = logger
}

/** 落盘 + stderr 的 logger。 */
export class FileLogger implements DesktopLogger {
  constructor(private readonly sink: LogFileSink | undefined) {}

  info(message: string): void {
    this.write('info', message)
  }
  warn(message: string): void {
    this.write('warn', message)
  }
  error(message: string): void {
    this.write('error', message)
  }
  errorCause(cause: unknown): void {
    this.error(cause instanceof Error ? cause.stack ?? cause.message : String(cause))
  }

  private write(level: LogLevel, message: string): void {
    try {
      this.sink?.write(level, message)
    } catch {
      // 落盘失败不阻塞
    }
    process.stderr.write(`[${level.toUpperCase()}] ${message}\n`)
  }
}

/** 渲染带 NTSTATUS 位模式的退出码，便于排查。 */
export function formatExitCode(exitCode: number): string {
  return `${String(exitCode)} / 0x${(exitCode >>> 0).toString(16).padStart(8, '0')}`
}

/** 安装 uncaughtException 捕获：首个异常落盘后请求致命退出，避免静默崩溃无现场。 */
export function installUncaughtExceptionCapture(exit: (code: number) => void): () => void {
  let handled = false
  const handler = (error: Error): void => {
    if (handled) return
    handled = true
    process.off('uncaughtException', handler)
    try {
      activeLogger.errorCause(error)
    } finally {
      exit(1)
    }
  }
  process.once('uncaughtException', handler)
  return () => {
    process.off('uncaughtException', handler)
  }
}

/**
 * 安装 Electron child-process-gone 监听：utility/GPU 等子进程异常退出落盘。
 * 返回卸载函数。直接用 Electron App 类型，避免手写 on/off 签名不匹配。
 */
export function installChildProcessGoneLogging(app: App): () => void {
  const handler = (_event: Electron.Event, details: Electron.Details): void => {
    const identity = [
      `type: ${details.type}`,
      ...(details.name === undefined ? [] : [`name: ${details.name}`]),
    ]
    activeLogger.error(
      `electron child-process-gone (${identity.join(', ')}, reason: ${details.reason}, exitCode: ${formatExitCode(details.exitCode)})`,
    )
  }
  app.on('child-process-gone', handler)
  return () => {
    app.off('child-process-gone', handler)
  }
}
