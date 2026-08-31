import { useEffect, useRef, useState } from 'react'

const harness = window.harness

type UpdateStatus = { state: string; version?: string; percent?: number; message?: string }

/** 设置 → 通用 → 关于：检查更新 + 状态显示（021 自动更新）。 */
export default function UpdateSection() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [lastCheck, setLastCheck] = useState<string | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 终态/有结果状态：收到后清除"检查中"前端超时兜底
  const isResultState = (s: string) =>
    s === 'up-to-date' || s === 'available' || s === 'error' || s === 'downloaded' || s === 'disabled'

  useEffect(() => {
    void window.__desktop__.getVersion().then((v) => setAppVersion(v))
    // 上次检查时间持久化在 localStorage（仅本机本查看者可见）
    try {
      setLastCheck(localStorage.getItem('update:lastCheck'))
    } catch {
      // localStorage 不可用时忽略
    }
    const off = harness.onUpdateStatus((s) => {
      setStatus(s)
      if (s.state !== 'downloading') setChecking(false)
      if (isResultState(s.state) && timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
      // 到达"检查完成"类终态时记录时间
      if (s.state === 'up-to-date' || s.state === 'available' || s.state === 'error') {
        const now = new Date().toLocaleString()
        setLastCheck(now)
        try {
          localStorage.setItem('update:lastCheck', now)
        } catch {
          // 忽略
        }
      }
    })
    return () => {
      off()
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  const check = async () => {
    setChecking(true)
    setStatus(null)
    // 前端超时兜底：主进程侧已有 25s 超时，这里 28s 再兜一层，确保按钮不会
    // 永久卡在"检查中…"（即使 update:status 事件因任何原因未回流）
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null
      setChecking(false)
      setStatus({ state: 'error', message: '检查更新超时，请稍后重试' })
    }, 28_000)
    const res = await harness.checkForUpdates()
    if (!res.ok) {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
      setChecking(false)
      setStatus({ state: 'error', message: res.error?.message ?? '检查更新失败' })
    }
  }

  const install = async () => {
    await harness.quitAndInstall()
  }

  return (
    <section>
      <h3>关于与更新</h3>
      <div className="setting-row">
        <span>当前版本</span>
        <span className="mono">v{appVersion || '1.0.0'}</span>
      </div>
      <div className="setting-row">
        <span>项目</span>
        <span>DSH Desktop · 开箱即用的 DeepSeek Harness 桌面客户端</span>
      </div>
      <div className="setting-row">
        <span>平台</span>
        <span className="topics-row">
          <span className="topic-tag">macOS</span>
          <span className="topic-tag">Windows</span>
          <span className="topic-tag">Linux</span>
        </span>
      </div>
      <div className="setting-row">
        <span>话题</span>
        <span className="topics-row">
          {['deepseek-harness', 'electron', 'desktop-app', 'ai-agent', 'react', 'typescript', 'llm'].map((t) => (
            <span key={t} className="topic-tag">
              {t}
            </span>
          ))}
        </span>
      </div>
      <div className="setting-input-row">
        <button className="btn secondary small" onClick={check} disabled={checking}>
          {checking ? '检查中…' : '检查更新'}
        </button>
        {lastCheck && !checking && (
          <span className="setting-hint">上次检查：{lastCheck}</span>
        )}
      </div>
      {status && (
        <div className={`settings-msg ${status.state === 'error' ? 'err' : status.state === 'disabled' ? 'warn' : 'ok'}`} style={{ marginTop: 8 }}>
          {status.state === 'checking' && '正在检查更新…'}
          {status.state === 'available' && `发现新版本 v${status.version}，正在后台下载…`}
          {status.state === 'downloading' && `正在下载更新 ${status.percent ?? 0}%`}
          {status.state === 'downloaded' && (
            <span>
              新版本 v{status.version} 已下载{' '}
              <button className="link-btn" onClick={install}>
                立即重启更新
              </button>
            </span>
          )}
          {status.state === 'error' && `检查更新失败：${status.message ?? '未知错误'}`}
          {status.state === 'up-to-date' && `已是最新版本（v${appVersion || '1.0.0'}）`}
          {status.state === 'disabled' && `${status.message ?? '自动更新不可用'}`}
        </div>
      )}
    </section>
  )
}
