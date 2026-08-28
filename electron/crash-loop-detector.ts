/**
 * electron/crash-loop-detector.ts —— 崩溃环检测器。
 *
 * 借鉴 dsh_desktop 的 Rust CrashLoopDetector（crash_loop.rs）。
 * 核心思路：两层熔断——
 *  1. 快环（fast loop）：60s 窗口内崩溃 ≥ MAX_FAST_CRASHES 次 → 判定崩溃环，
 *     停止自动重启，进入恢复态。
 *  2. 慢环（slow fuse）：累计自动重启 ≥ MAX_AUTO_RESTARTS 次 → 同样判定，
 *     防止"每 2 分钟崩一次"的慢速崩溃无限重启。
 *
 * 判定结果：
 *  - Ok      → 可以自动重启（重置快环窗口）
 *  - Tripped → 已触发崩溃环，停止重启，进入恢复页
 *  - Cooldown → 慢环达到上限后的冷却期，同样停止重启
 */
export type CrashVerdict = 'ok' | 'tripped' | 'cooldown'

/** 快环窗口（ms）：只统计窗口内的崩溃。 */
const FAST_WINDOW_MS = 60_000
/** 快环阈值：窗口内崩溃达此数即判定崩溃环。 */
const MAX_FAST_CRASHES = 5
/** 慢环阈值：累计自动重启达此数即判定冷却。 */
const MAX_AUTO_RESTARTS = 5

/**
 * 崩溃环检测器。纯逻辑、无副作用、可独立单测。
 *
 * 用法：
 *   detector.recordCrash() → 返回 Verdict
 *   detector.recordGoodBoot() → 引擎稳定运行后调用，重置慢环计数
 */
export class CrashLoopDetector {
  /** 快环：窗口内的崩溃时间戳数组。 */
  private fastCrashes: number[] = []
  /** 慢环：累计自动重启次数（仅 recordGoodBoot 重置）。 */
  private autoRestarts = 0
  /** 是否已进入不可恢复态（避免恢复后再次 recordCrash 又判 ok）。 */
  private tripped = false

  /**
   * 记录一次崩溃，返回是否允许自动重启。
   * @param now 当前时间戳（可注入用于测试），默认 Date.now()
   */
  recordCrash(now: number = Date.now()): CrashVerdict {
    // 清理快环窗口外的旧记录
    const cutoff = now - FAST_WINDOW_MS
    this.fastCrashes = this.fastCrashes.filter((t) => t >= cutoff)
    this.fastCrashes.push(now)

    // 快环：窗口内崩溃数超阈值
    if (this.fastCrashes.length >= MAX_FAST_CRASHES) {
      this.tripped = true
      return 'tripped'
    }

    // 慢环：累计重启次数超阈值
    this.autoRestarts += 1
    if (this.autoRestarts >= MAX_AUTO_RESTARTS) {
      this.tripped = true
      return 'cooldown'
    }

    return 'ok'
  }

  /**
   * 引擎稳定运行后调用（对应参考项目的 45s markGood）。
   * 重置慢环计数与快环窗口——一次稳定启动"赎回"之前的崩溃历史。
   */
  recordGoodBoot(): void {
    this.autoRestarts = 0
    this.fastCrashes = []
    this.tripped = false
  }

  /** 是否已触发崩溃环（恢复页用）。 */
  get isTripped(): boolean {
    return this.tripped
  }

  /** 当前累计自动重启次数（诊断用）。 */
  get restartCount(): number {
    return this.autoRestarts
  }

  /** 快环窗口内当前崩溃数（诊断用，可注入 now 用于测试）。 */
  fastCrashCount(now: number = Date.now()): number {
    const cutoff = now - FAST_WINDOW_MS
    return this.fastCrashes.filter((t) => t >= cutoff).length
  }

  /**
   * 手动重置（恢复页"重启内核"按钮调用，给用户一次重新尝试的机会）。
   * 与 recordGoodBoot 的区别：这里不要求引擎已稳定，而是清零给手动重试让路。
   */
  reset(): void {
    this.fastCrashes = []
    this.autoRestarts = 0
    this.tripped = false
  }
}
