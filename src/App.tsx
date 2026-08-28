import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, DshStatus } from '../shared/types'
import Wizard from './components/Wizard'
import MainView from './components/MainView'
import WhaleLogo from './components/WhaleLogo'
import { emit } from './bus'

const harness = window.harness

export default function App() {
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null)
  const [dshStatus, setDshStatus] = useState<DshStatus | null>(null)
  const [booting, setBooting] = useState(true)
  const [fatal, setFatal] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [sessionListVersion, setSessionListVersion] = useState(0)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [stateRes, statusRes] = await Promise.all([harness.getAppState(), harness.ensureDsh()])
        if (!alive) return
        if (stateRes.ok) setAppSettings(stateRes.value!)
        if (statusRes.ok) setDshStatus(statusRes.value!)
        else if (statusRes.error) setFatal(statusRes.error.message)
      } catch (e) {
        if (alive) setFatal((e as Error).message)
      } finally {
        if (alive) setBooting(false)
      }
    })()

    const offEvent = harness.onSessionEvent((evt) => {
      emit(evt)
      if (evt.kind === 'title' || evt.kind === 'running' || evt.kind === 'session-subscribed') {
        setSessionListVersion((v) => v + 1)
      }
    })
    const offStatus = harness.onDshStatus((s) => {
      if (alive) setDshStatus(s)
    })
    return () => {
      alive = false
      offEvent()
      offStatus()
    }
  }, [])

  const onUpdateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const res = await harness.updateAppSettings(patch)
    if (res.ok) setAppSettings(res.value!)
    return res
  }, [])

  const onCompleteWizard = useCallback(
    async (workspaceCwd: string | null) => {
      const res = await harness.updateAppSettings({ onboarded: true, workspaceCwd: workspaceCwd || null })
      if (res.ok) setAppSettings(res.value!)
    },
    [],
  )

  const onSkipWizard = useCallback(async () => {
    const res = await harness.updateAppSettings({ onboarded: true })
    if (res.ok) setAppSettings(res.value!)
  }, [])

  // 外观：主题 / 主题色 / 字体 / 密度 通过 html 属性驱动 CSS 变量，即时生效
  useEffect(() => {
    const appearance = appSettings?.appearance
    if (!appearance) return
    const root = document.documentElement
    const applyTheme = () => {
      // system → 用 matchMedia 解析成 light/dark（CSS 只有 [data-theme=light] 与深色 :root）
      let resolved = appearance.theme
      if (resolved === 'system') {
        resolved = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
      }
      root.setAttribute('data-theme', resolved)
    }
    applyTheme()
    root.setAttribute('data-accent', appearance.accent)
    root.setAttribute('data-font-size', appearance.fontSize)
    root.setAttribute('data-density', appearance.density)
    // system 模式下跟随系统主题实时切换
    if (appearance.theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: light)')
      mq.addEventListener('change', applyTheme)
      return () => mq.removeEventListener('change', applyTheme)
    }
  }, [appSettings?.appearance])

  if (booting) {
    return (
      <div className="boot-screen">
        <WhaleLogo className="boot-logo" />
        <div className="boot-text">正在启动 DeepSeek Harness 引擎…</div>
      </div>
    )
  }

  if (fatal) {
    return (
      <div className="boot-screen">
        <div className="boot-text">{fatal}</div>
        <button className="btn primary" onClick={() => window.location.reload()}>
          重试
        </button>
      </div>
    )
  }

  // 崩溃恢复态：引擎反复崩溃已触发崩溃环熔断，展示恢复页 + 手动重启按钮
  if (dshStatus?.recovery) {
    return (
      <div className="boot-screen">
        <WhaleLogo className="boot-logo" />
        <div className="boot-text">引擎反复崩溃，已进入恢复模式</div>
        <div className="boot-subtext" style={{ fontSize: 13, color: 'var(--dsw-text-2)', marginTop: 4, maxWidth: 420, textAlign: 'center' }}>
          {dshStatus.error ?? '内核在短时间内多次崩溃，已停止自动重启。你可以检查配置后手动重启内核。'}
        </div>
        <button
          className="btn primary"
          disabled={restarting}
          onClick={async () => {
            setRestarting(true)
            try {
              const res = await harness.restartDsh()
              if (!res.ok && res.error) setFatal(res.error.message)
            } catch (e) {
              setFatal((e as Error).message)
            } finally {
              setRestarting(false)
            }
          }}
        >
          {restarting ? '正在重启…' : '重启内核'}
        </button>
      </div>
    )
  }

  if (!appSettings?.onboarded) {
    return (
      <Wizard
        dshReady={dshStatus?.ready ?? false}
        onComplete={onCompleteWizard}
        onSkip={onSkipWizard}
      />
    )
  }

  return (
    <MainView
      appSettings={appSettings}
      dshStatus={dshStatus}
      onUpdateSettings={onUpdateSettings}
      sessionListVersion={sessionListVersion}
      onSessionListTick={() => setSessionListVersion((v) => v + 1)}
    />
  )
}
