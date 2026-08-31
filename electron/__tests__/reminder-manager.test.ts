/**
 * electron/__tests__/reminder-manager.test.ts —— 定时提醒单测。
 *
 * 重点覆盖周期提醒（every/daily/weekly）目标会话被删时的行为：不能无限重排，
 * 连续失败达上限须丢弃（回归此前"周期提醒无条件重排，永久空转"的缺陷）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReminderManager } from '../reminder-manager.js'
import type { AppSettings, Reminder } from '../../shared/types.js'
import type { DshAdapter } from '../../adapter/index.js'

function makeAdapter(sessionIds: string[]): DshAdapter {
  return {
    listSessions: vi.fn(async () => sessionIds.map((sessionId) => ({ sessionId, title: '', updatedAt: 0, running: false, blank: false }))),
    sendMessage: vi.fn(async () => ({ accepted: true })),
  } as unknown as DshAdapter
}

describe('ReminderManager', () => {
  let reminders: Reminder[]
  let adapter: DshAdapter | null

  const getSettings = (): AppSettings => ({ reminders }) as AppSettings
  const persist = (next: Reminder[]) => {
    reminders = next
  }

  beforeEach(() => {
    vi.useFakeTimers()
    reminders = []
    adapter = null
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('周期提醒目标会话被删：连续失败超过上限后丢弃，而不是无限重排', async () => {
    const now = 1_000_000
    vi.setSystemTime(now)
    reminders = [
      { id: 'r1', text: 'hi', kind: 'every', everySeconds: 300, sessionId: 'missing-session', nextAt: now },
    ]
    adapter = makeAdapter([]) // 目标会话已被删

    const mgr = new ReminderManager(getSettings, persist, () => adapter, undefined)

    // 每次 tick 都到期立刻重排（everySeconds=300s），连续失败 11 次应超过 MAX_RETRIES=10 而丢弃
    for (let i = 0; i < 11; i++) {
      await (mgr as unknown as { runTick: () => Promise<void> }).runTick()
      // 手动把 nextAt 拨回"已到期"，模拟又经过一个 tick 周期
      if (reminders[0]) reminders[0] = { ...reminders[0], nextAt: Date.now() }
    }

    expect(reminders.find((r) => r.id === 'r1')).toBeUndefined()
  })

  it('周期提醒触发成功：consecutiveFailures 清零且提醒保留', async () => {
    const now = 1_000_000
    vi.setSystemTime(now)
    reminders = [{ id: 'r1', text: 'hi', kind: 'daily', dailyTime: '09:00', sessionId: 's1', nextAt: now, consecutiveFailures: 3 }]
    adapter = makeAdapter(['s1'])

    const mgr = new ReminderManager(getSettings, persist, () => adapter, undefined)
    await (mgr as unknown as { runTick: () => Promise<void> }).runTick()

    const r = reminders.find((x) => x.id === 'r1')
    expect(r).toBeDefined()
    expect(r?.consecutiveFailures).toBe(0)
  })

  it('一次性提醒（after）失败仍按原有重试上限顺延，不受周期提醒逻辑影响', async () => {
    const now = 1_000_000
    vi.setSystemTime(now)
    reminders = [{ id: 'r1', text: 'hi', kind: 'after', afterSeconds: 0, sessionId: 'missing', nextAt: now }]
    adapter = makeAdapter([])

    const mgr = new ReminderManager(getSettings, persist, () => adapter, undefined)
    await (mgr as unknown as { runTick: () => Promise<void> }).runTick()

    const r = reminders.find((x) => x.id === 'r1')
    expect(r?.retries).toBe(1)
    expect(r?.nextAt).toBeGreaterThan(now)
  })
})
