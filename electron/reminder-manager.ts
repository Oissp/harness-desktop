/**
 * electron/reminder-manager.ts —— 桌面端定时提醒。
 *
 * dsh 的 schedule 是 agent 工具（无公开 RPC），这里在桌面端实现：
 * 到点后用 session.prompt 把提醒作为用户消息注入目标会话。
 * 数据存 app-settings.json（reminders 字段）。
 */
import type { AppSettings, Reminder } from '../shared/types.js'
import type { DshAdapter } from '../adapter/index.js'

const TICK_MS = 10_000

/** 计算下一个每日触发时刻（HH:MM）。 */
function nextDaily(hhmm: string, now: number): number {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date(now)
  d.setHours(h ?? 9, m ?? 0, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** 计算下一个每周触发时刻（星期 + HH:MM，周日=0）。 */
function nextWeekly(day: number, hhmm: string, now: number): number {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date(now)
  d.setHours(h ?? 9, m ?? 0, 0, 0)
  while (d.getDay() !== ((day % 7) + 7) % 7 || d.getTime() <= now) {
    d.setDate(d.getDate() + 1)
  }
  return d.getTime()
}

export class ReminderManager {
  private timer: ReturnType<typeof setInterval> | null = null
  /** tick 串行闸：fire() 走 adapter 可能远超 TICK_MS，重入直接跳过避免双发/覆盖。 */
  private ticking = false

  constructor(
    private getSettings: () => AppSettings,
    private persist: (reminders: Reminder[]) => void,
    private getAdapter: () => DshAdapter | null,
    private onFired?: (r: Reminder, sessionId: string) => void,
  ) {}

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    void this.tick()
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  list(): Reminder[] {
    return this.getSettings().reminders ?? []
  }

  create(input: Omit<Reminder, 'id' | 'nextAt'>): Reminder {
    const now = Date.now()
    const id = `rem-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const nextAt =
      input.kind === 'after'
        ? now + (input.afterSeconds ?? 0) * 1000
        : input.kind === 'at'
          ? (input.at ?? now)
          : input.kind === 'every'
            ? now + (input.everySeconds ?? 300) * 1000
            : input.kind === 'daily'
              ? nextDaily(input.dailyTime ?? '09:00', now)
              : nextWeekly(input.weeklyDay ?? 0, input.dailyTime ?? '09:00', now)
    const reminder: Reminder = { ...input, id, nextAt }
    this.persist([...this.list(), reminder])
    return reminder
  }

  delete(id: string): void {
    this.persist(this.list().filter((r) => r.id !== id))
  }

  private async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.runTick()
    } finally {
      this.ticking = false
    }
  }

  private async runTick() {
    const now = Date.now()
    const reminders = this.list()
    const due = reminders.filter((r) => r.nextAt <= now)
    if (due.length === 0) return
    const firedOk: string[] = []
    for (const r of due) {
      const ok = await this.fire(r)
      if (ok) firedOk.push(r.id)
    }
    const remaining: Reminder[] = []
    for (const r of reminders) {
      if (r.nextAt > now) {
        remaining.push(r)
        continue
      }
      const isPeriodic = r.kind === 'every' || r.kind === 'daily' || r.kind === 'weekly'
      if (isPeriodic) {
        // 周期提醒：连续失败（如目标会话已被删）不能无限重排——否则会永久空转、
        // 且用户毫无感知。连续失败达上限即丢弃并告警，与一次性提醒的重试上限对齐。
        const ok = firedOk.includes(r.id)
        const failures = ok ? 0 : (r.consecutiveFailures ?? 0) + 1
        if (!ok && failures > MAX_RETRIES) {
          console.warn(`[harness-desktop] 周期提醒 ${r.id} 连续失败 ${MAX_RETRIES} 次，丢弃`)
          continue
        }
        const nextAt =
          r.kind === 'every' && r.everySeconds
            ? now + r.everySeconds * 1000
            : r.kind === 'daily'
              ? nextDaily(r.dailyTime ?? '09:00', now)
              : nextWeekly(r.weeklyDay ?? 0, r.dailyTime ?? '09:00', now)
        remaining.push({ ...r, nextAt, consecutiveFailures: failures })
      } else if (!firedOk.includes(r.id)) {
        // 一次性提醒（after/at）触发失败：顺延重试，不丢
        const retries = (r.retries ?? 0) + 1
        if (retries <= MAX_RETRIES) {
          remaining.push({ ...r, nextAt: now + RETRY_DELAY_MS, retries })
        } else {
          console.warn(`[harness-desktop] 提醒 ${r.id} 重试 ${MAX_RETRIES} 次仍失败，丢弃`)
        }
      }
      // 一次性提醒成功（firedOk）→ 不再保留
    }
    this.persist(remaining)
  }

  /** 触发提醒；返回是否成功（成功才从一次性提醒列表移除）。 */
  private async fire(r: Reminder): Promise<boolean> {
    const adapter = this.getAdapter()
    if (!adapter) return false
    try {
      const sessions = await adapter.listSessions()
      // 目标会话被删时不要串门到 sessions[0]——提醒文本会落到无关会话。
      // 直接判失败（一次性提醒走重试，周期提醒等下一轮），保留提醒记录。
      const target = sessions.find((s) => s.sessionId === r.sessionId)
      if (!target) return false
      await adapter.sendMessage(target.sessionId, `[定时提醒] ${r.text}`)
      this.onFired?.(r, target.sessionId)
      return true
    } catch {
      return false
    }
  }
}

const RETRY_DELAY_MS = 30_000
const MAX_RETRIES = 10
