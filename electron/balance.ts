/**
 * electron/balance.ts —— 余额数据层（查询 DeepSeek 账户余额）。
 *
 * 借鉴 dsh_desktop 的 balance.js 数据层：调 DeepSeek 官方余额 API，
 * 返回归一化的余额信息。无 Electron 依赖，可独立单测。
 */
export interface BalanceInfo {
  /** 是否可用。 */
  ok: boolean
  /** 错误信息（ok=false 时）。 */
  error?: string
  /** 账户总余额（CNY，分）。 */
  totalBalanceCents?: number
  /** 已用额度（CNY，分）。 */
  usedCents?: number
  /** 剩余额度（CNY，分）。 */
  remainingCents?: number
  /** 货币符号。 */
  currency?: string
  /** 查询时间戳。 */
  fetchedAt: number
}

const DEFAULT_BASE = 'https://api.deepseek.com'

/**
 * 查询 DeepSeek 账户余额。
 * @param apiKey DeepSeek API Key
 * @param baseURL 可覆盖的 API 基址
 */
export async function queryBalance(apiKey: string, baseURL: string = DEFAULT_BASE): Promise<BalanceInfo> {
  if (!apiKey) {
    return { ok: false, error: '未配置 API Key', fetchedAt: Date.now() }
  }
  try {
    const res = await fetch(`${baseURL}/user/balance`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: `HTTP ${res.status} ${body.slice(0, 120)}`, fetchedAt: Date.now() }
    }
    const data = (await res.json()) as {
      is_available?: boolean
      balance_infos?: Array<{
        currency?: string
        total_balance?: number
        granted_balance?: number
        topped_up_balance?: number
      }>
    }
    // DeepSeek 余额 API：balance_infos 数组，每个含 currency + total_balance（单位：CNY 元）
    const info = data.balance_infos?.[0]
    if (!info) {
      return { ok: false, error: '余额信息为空', fetchedAt: Date.now() }
    }
    const total = info.total_balance ?? 0
    const granted = info.granted_balance ?? 0
    const toppedUp = info.topped_up_balance ?? 0
    return {
      ok: true,
      totalBalanceCents: Math.round(total * 100),
      usedCents: Math.round((granted + toppedUp - total) * 100),
      remainingCents: Math.round(total * 100),
      currency: info.currency ?? 'CNY',
      fetchedAt: Date.now(),
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? String(err), fetchedAt: Date.now() }
  }
}

/** 把分转成元显示字符串（保留 2 位小数）。 */
export function centsToYuan(cents: number): string {
  return (cents / 100).toFixed(2)
}

/**
 * 把数据层 BalanceInfo 归一化成 renderer 友好的 BalanceResult（分→元字符串）。
 * push 推送与 IPC refresh 返回共用此转换，避免 handler 伪造成功。
 */
export function toBalanceResult(info: BalanceInfo): import('../shared/types.js').BalanceResult {
  return {
    ok: info.ok,
    error: info.error,
    totalYuan: info.totalBalanceCents != null ? centsToYuan(info.totalBalanceCents) : undefined,
    usedYuan: info.usedCents != null ? centsToYuan(info.usedCents) : undefined,
    remainingYuan: info.remainingCents != null ? centsToYuan(info.remainingCents) : undefined,
    currency: info.currency,
    fetchedAt: info.fetchedAt,
  }
}
