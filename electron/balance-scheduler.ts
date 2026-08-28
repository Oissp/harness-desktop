/**
 * electron/balance-scheduler.ts —— 余额轮询调度器（编排层）。
 *
 * 借鉴 dsh_desktop 的 balance-scheduler.js：
 *  - in-flight 去重 + 最新序列号守卫（只让最新请求的结果写出）
 *  - 指数退避重试（失败后 30s→1m→2m→5m）
 *  - 后台固定间隔轮询（默认 3 分钟）
 *  - 单出口 push(result)，IPC handler 只触发 refresh，renderer 只消费推送
 *
 * 无 Electron 依赖，通过注入的回调与外界通信，可独立单测。
 */
import type { BalanceInfo } from './balance.js'

/** 轮询间隔（ms）。 */
const POLL_INTERVAL_MS = 3 * 60_000
/** 指数退避重试间隔（ms）。 */
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000]
/** 非强制刷新的节流窗口（ms）。 */
const THROTTLE_MS = 30_000

/** 调度器依赖注入接口（解耦 Electron / fetch，便于测试）。 */
export interface BalanceSchedulerDeps {
  /** 查询余额（返回 BalanceInfo）。 */
  query: () => Promise<BalanceInfo>
  /** 推送结果给消费者（renderer）。 */
  push: (result: BalanceInfo) => void
  /** 当前是否应暂停轮询（如窗口最小化/隐藏）。 */
  isPaused?: () => boolean
}

export class BalanceScheduler {
  private deps: BalanceSchedulerDeps
  /** 轮询定时器。 */
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  /** 重试定时器。 */
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  /** 当前进行中的查询（in-flight 去重）。 */
  private inflight: Promise<BalanceInfo> | null = null
  /** 最新请求的序列号（旧请求的结果被丢弃）。 */
  private seq = 0
  /** 上次刷新时间戳（节流用）。 */
  private lastRefreshAt = 0
  /** 当前重试次数（指数退避索引）。 */
  private retryIndex = 0
  /** 是否已启动。 */
  private started = false
  /** 最近一次查询结果（供 IPC 同步返回，避免 handler 伪造成功）。 */
  private lastResult: BalanceInfo | null = null

  constructor(deps: BalanceSchedulerDeps) {
    this.deps = deps
  }

  /** 启动：立即强制刷新一次 + 定时轮询。 */
  start(): void {
    if (this.started) return
    this.started = true
    void this.refresh(true)
    this.schedulePoll()
  }

  /** 停止所有定时器。 */
  stop(): void {
    this.started = false
    this.lastResult = null
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  /** 最近一次查询结果（null = 尚未查询过）。IPC refresh handler 用它返回真实结果。 */
  getLastResult(): BalanceInfo | null {
    return this.lastResult
  }

  /**
   * 手动触发刷新（IPC handler 调用）。
   * @param force 是否跳过节流（用户主动点击"刷新"时 force=true）
   */
  async refresh(force = false): Promise<void> {
    // 节流：非强制刷新在窗口内跳过
    const now = Date.now()
    if (!force && now - this.lastRefreshAt < THROTTLE_MS) return

    // in-flight 去重：已有查询进行中则不重复发起
    if (this.inflight) return

    this.lastRefreshAt = now
    this.seq += 1
    const mySeq = this.seq

    try {
      this.inflight = this.deps.query()
      const result = await this.inflight
      // 最新序列号守卫：只处理最新请求的结果
      if (mySeq === this.seq) {
        this.lastResult = result
        this.deps.push(result)
        if (result.ok) {
          // 成功 → 重置重试
          this.retryIndex = 0
          if (this.retryTimer) {
            clearTimeout(this.retryTimer)
            this.retryTimer = null
          }
        } else {
          // 失败 → 指数退避重试
          this.scheduleRetry()
        }
      }
    } catch {
      // 查询异常也走重试
      if (mySeq === this.seq) this.scheduleRetry()
    } finally {
      this.inflight = null
    }
  }

  /** 安排下一次轮询（固定间隔）。 */
  private schedulePoll(): void {
    if (!this.started) return
    this.pollTimer = setTimeout(() => {
      if (!this.started) return
      // 窗口最小化/隐藏时暂停轮询（但不推进节流）
      if (this.deps.isPaused?.() !== true) {
        void this.refresh(false)
      }
      this.schedulePoll()
    }, POLL_INTERVAL_MS)
  }

  /** 安排指数退避重试。 */
  private scheduleRetry(): void {
    if (!this.started) return
    if (this.retryIndex >= RETRY_DELAYS_MS.length) {
      // 超过最大重试次数 → 停止重试，等下次轮询
      this.retryIndex = 0
      return
    }
    const delay = RETRY_DELAYS_MS[this.retryIndex]
    this.retryIndex += 1
    this.retryTimer = setTimeout(() => {
      if (!this.started) return
      void this.refresh(true)
    }, delay)
  }
}
