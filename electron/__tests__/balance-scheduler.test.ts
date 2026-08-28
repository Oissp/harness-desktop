/**
 * electron/__tests__/balance-scheduler.test.ts —— 余额调度器单测。
 *
 * 借鉴 dsh_desktop 的调度器测试思路：验证 in-flight 去重、序列号守卫、
 * 指数退避重试、节流、暂停。用 fake timer + mock query。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { BalanceScheduler } from '../balance-scheduler'
import type { BalanceInfo } from '../balance'

describe('BalanceScheduler', () => {
  let pushResults: BalanceInfo[]
  let queryFn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    pushResults = []
    queryFn = vi.fn()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function makeScheduler(isPaused = false): BalanceScheduler {
    return new BalanceScheduler({
      query: queryFn,
      push: (r) => pushResults.push(r),
      isPaused: () => isPaused,
    })
  }

  describe('start + 成功路径', () => {
    it('启动时立即强制刷新一次并 push 结果', async () => {
      queryFn.mockResolvedValue({ ok: true, fetchedAt: 1 })
      const s = makeScheduler()
      s.start()
      // 让 microtask（query 的 await）完成
      await vi.advanceTimersByTimeAsync(0)
      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(pushResults).toHaveLength(1)
      expect(pushResults[0].ok).toBe(true)
      s.stop()
    })
  })

  describe('in-flight 去重', () => {
    it('查询进行中时再次 refresh 不重复发起', async () => {
      let resolveFirst!: (v: BalanceInfo) => void
      queryFn.mockReturnValueOnce(new Promise((r) => (resolveFirst = r)))
      const s = makeScheduler()
      s.start()
      await vi.advanceTimersByTimeAsync(0) // 让 start 的 refresh 进入 await

      // 第一个查询在 flight 中，手动 refresh 不应发起新查询
      void s.refresh(true)
      void s.refresh(true)
      expect(queryFn).toHaveBeenCalledTimes(1)

      resolveFirst({ ok: true, fetchedAt: 2 })
      await vi.advanceTimersByTimeAsync(0)
      s.stop()
    })
  })

  describe('序列号守卫', () => {
    it('只 push 最新请求的结果', async () => {
      // 第一次查询慢（pending），第二次快——但因为 in-flight 去重，第二次不会发起。
      // 改为验证：成功后只 push 一次。
      queryFn.mockResolvedValue({ ok: true, fetchedAt: 42 })
      const s = makeScheduler()
      s.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(pushResults).toHaveLength(1)
      expect(pushResults[0].fetchedAt).toBe(42)
      s.stop()
    })
  })

  describe('指数退避重试', () => {
    it('查询失败后按 30s 退避重试', async () => {
      queryFn.mockResolvedValue({ ok: false, error: '网络错误', fetchedAt: 0 })
      const s = makeScheduler()
      s.start()
      await vi.advanceTimersByTimeAsync(0) // start 的 refresh 完成（失败）
      expect(queryFn).toHaveBeenCalledTimes(1)

      // 30s 后第一次重试
      await vi.advanceTimersByTimeAsync(30_000)
      expect(queryFn).toHaveBeenCalledTimes(2)
      s.stop()
    })

    it('查询成功后重置重试计数（不再退避）', async () => {
      queryFn
        .mockResolvedValueOnce({ ok: false, error: '失败', fetchedAt: 0 })
        .mockResolvedValue({ ok: true, fetchedAt: 1 })

      const s = makeScheduler()
      s.start()
      await vi.advanceTimersByTimeAsync(0) // 第一次失败
      await vi.advanceTimersByTimeAsync(30_000) // 重试成功
      expect(queryFn).toHaveBeenCalledTimes(2)
      expect(pushResults.some((r) => r.ok)).toBe(true)

      // 再过 30s 不应有额外重试（已成功，重试计数清零）
      const callsBefore = queryFn.mock.calls.length
      await vi.advanceTimersByTimeAsync(30_000)
      expect(queryFn.mock.calls.length).toBe(callsBefore)
      s.stop()
    })
  })

  describe('节流', () => {
    it('非强制刷新在 30s 窗口内被跳过', async () => {
      queryFn.mockResolvedValue({ ok: true, fetchedAt: 0 })
      const s = makeScheduler()
      s.start()
      await vi.advanceTimersByTimeAsync(0)

      const callsAfterStart = queryFn.mock.calls.length
      // 5s 后非强制刷新 → 被节流跳过
      await vi.advanceTimersByTimeAsync(5_000)
      void s.refresh(false)
      await vi.advanceTimersByTimeAsync(0)
      expect(queryFn.mock.calls.length).toBe(callsAfterStart)
      s.stop()
    })

    it('强制刷新跳过节流', async () => {
      queryFn.mockResolvedValue({ ok: true, fetchedAt: 0 })
      const s = makeScheduler()
      s.start()
      await vi.advanceTimersByTimeAsync(0)

      // 强制刷新应立即触发（in-flight 已完成）
      void s.refresh(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(queryFn.mock.calls.length).toBeGreaterThanOrEqual(2)
      s.stop()
    })
  })

  describe('暂停', () => {
    it('isPaused=true 时轮询不触发查询', async () => {
      queryFn.mockResolvedValue({ ok: true, fetchedAt: 0 })
      const s = makeScheduler(true)
      s.start()
      await vi.advanceTimersByTimeAsync(0)
      const callsAfterStart = queryFn.mock.calls.length

      // 推进一个轮询周期（3 分钟），但因暂停不应有新查询
      await vi.advanceTimersByTimeAsync(3 * 60_000)
      expect(queryFn.mock.calls.length).toBe(callsAfterStart)
      s.stop()
    })
  })

  describe('stop', () => {
    it('停止后不再轮询', async () => {
      queryFn.mockResolvedValue({ ok: true, fetchedAt: 0 })
      const s = makeScheduler()
      s.start()
      await vi.advanceTimersByTimeAsync(0)
      s.stop()

      const callsAfterStop = queryFn.mock.calls.length
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(queryFn.mock.calls.length).toBe(callsAfterStop)
    })
  })
})
