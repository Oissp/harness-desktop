/**
 * electron/__tests__/crash-loop-detector.test.ts —— 崩溃环检测器单测。
 *
 * 借鉴 dsh_desktop 的 Rust 破坏性实测思路：验证快环/慢环两层熔断 + markGood 赎回。
 */
import { describe, expect, it } from 'vitest'
import { CrashLoopDetector } from '../crash-loop-detector'

describe('CrashLoopDetector', () => {
  describe('快环（60s 窗口 / 5 次崩溃）', () => {
    it('窗口内崩溃 < 5 次返回 ok', () => {
      const d = new CrashLoopDetector()
      const base = 1_000_000
      expect(d.recordCrash(base)).toBe('ok')
      expect(d.recordCrash(base + 1_000)).toBe('ok')
      expect(d.recordCrash(base + 2_000)).toBe('ok')
      expect(d.recordCrash(base + 3_000)).toBe('ok')
      // 4 次，未触发
      expect(d.isTripped).toBe(false)
    })

    it('窗口内崩溃 ≥ 5 次返回 tripped', () => {
      const d = new CrashLoopDetector()
      const base = 1_000_000
      for (let i = 0; i < 4; i++) {
        expect(d.recordCrash(base + i * 1_000)).toBe('ok')
      }
      // 第 5 次触发
      expect(d.recordCrash(base + 4_000)).toBe('tripped')
      expect(d.isTripped).toBe(true)
    })

    it('窗口外的旧崩溃会被清理，不累计到快环', () => {
      const d = new CrashLoopDetector()
      const base = 1_000_000
      // 2 次崩溃，间隔 30s（在 60s 窗口内）；慢环计数 = 2
      d.recordCrash(base)
      d.recordCrash(base + 30_000)
      expect(d.fastCrashCount(base + 30_000)).toBe(2)

      // 70s 后再崩——前 2 次已出 60s 窗口，快环归零
      // 快环 = 1（只有本次），慢环 = 3（未达 5）→ ok
      const now = base + 30_000 + 70_000
      const verdict = d.recordCrash(now)
      expect(verdict).toBe('ok')
      // 快环只算本次（窗口内仅 1 条）
      expect(d.fastCrashCount(now)).toBe(1)
      expect(d.isTripped).toBe(false)
    })
  })

  describe('慢环（累计 5 次自动重启）', () => {
    it('每次崩溃 +1 自动重启计数，达 5 次返回 cooldown', () => {
      const d = new CrashLoopDetector()
      const base = 1_000_000
      // 每次崩溃间隔 20s（不出快环），累计慢环
      let last = base
      for (let i = 0; i < 4; i++) {
        last = base + i * 20_000
        expect(d.recordCrash(last)).toBe('ok')
      }
      // 第 5 次：慢环达阈值 → cooldown
      expect(d.recordCrash(last + 20_000)).toBe('cooldown')
      expect(d.isTripped).toBe(true)
    })
  })

  describe('markGoodBoot 赎回', () => {
    it('稳定启动后重置计数，之前崩溃不再累计', () => {
      const d = new CrashLoopDetector()
      const base = 1_000_000
      // 3 次崩溃（慢环计数 3，未触发）
      d.recordCrash(base)
      d.recordCrash(base + 20_000)
      d.recordCrash(base + 40_000)
      expect(d.restartCount).toBe(3)

      // 稳定启动 → 赎回
      d.recordGoodBoot()
      expect(d.restartCount).toBe(0)
      expect(d.isTripped).toBe(false)

      // 再崩 3 次仍 ok
      d.recordCrash(base + 100_000)
      d.recordCrash(base + 120_000)
      expect(d.recordCrash(base + 140_000)).toBe('ok')
    })
  })

  describe('reset（手动重试）', () => {
    it('触发崩溃环后 reset 清零，允许重新尝试', () => {
      const d = new CrashLoopDetector()
      const base = 1_000_000
      for (let i = 0; i < 5; i++) {
        d.recordCrash(base + i * 1_000)
      }
      expect(d.isTripped).toBe(true)

      d.reset()
      expect(d.isTripped).toBe(false)
      expect(d.restartCount).toBe(0)
      expect(d.recordCrash(base + 10_000)).toBe('ok')
    })
  })

  describe('tripped 后不再判 ok', () => {
    it('一旦 tripped，后续 recordCrash 保持 tripped', () => {
      const d = new CrashLoopDetector()
      const base = 1_000_000
      for (let i = 0; i < 5; i++) {
        d.recordCrash(base + i * 1_000)
      }
      // 间隔很久再崩，仍 tripped（不会因为窗口清理而回 ok）
      expect(d.recordCrash(base + 999_999)).not.toBe('ok')
    })
  })
})
