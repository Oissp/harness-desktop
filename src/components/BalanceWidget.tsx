import { useEffect, useState } from 'react'
import type { BalanceResult } from '../../shared/types'

const harness = window.harness

/**
 * 输入区右下角的余额小部件：显示「余额 ¥XX.XX」，点击刷新。
 * 借鉴 dsh_desktop 的「本轮费用·余额」小部件，但简化为余额展示。
 *
 * 引擎就绪后由主进程 balance-scheduler 定时推送（3 分钟轮询），
 * 也可手动点击刷新（强制跳过节流）。
 */
export default function BalanceWidget() {
  const [balance, setBalance] = useState<BalanceResult | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    const off = harness.onBalanceChanged((result) => {
      setBalance(result)
      setRefreshing(false)
    })
    return off
  }, [])

  // 不显示的情况：未就绪 / 查询失败且无历史
  if (!balance) return null

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await harness.refreshBalance()
    } catch {
      setRefreshing(false)
    }
  }

  if (!balance.ok) {
    return (
      <button
        className="balance-widget"
        onClick={handleRefresh}
        disabled={refreshing}
        title={balance.error ?? '余额查询失败'}
      >
        <span className="balance-widget-text">余额查询失败</span>
      </button>
    )
  }

  const amount = balance.remainingYuan ?? balance.totalYuan ?? '—'
  const currency = balance.currency === 'CNY' ? '¥' : balance.currency ? `${balance.currency} ` : '¥'

  return (
    <button
      className="balance-widget"
      onClick={handleRefresh}
      disabled={refreshing}
      title={`总余额 ${balance.totalYuan ?? '—'} · 已用 ${balance.usedYuan ?? '—'} · 点击刷新`}
    >
      <span className="balance-widget-label">余额</span>
      <span className="balance-widget-amount">
        {refreshing ? '…' : `${currency}${amount}`}
      </span>
    </button>
  )
}
