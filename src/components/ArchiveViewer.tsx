import { useEffect, useState } from 'react'
import { archiveReducer, emptyArchive, type ArchiveState } from '../archiveReducer'
import type { ChatMessage } from '../../shared/types'
import MessageList from './MessageList'
import WhaleLogo from './WhaleLogo'

const harness = window.harness

interface Props {
  sessionId: string
  title?: string
}

/**
 * 归档会话只读视图：用 archiveReducer（只处理完整消息）折叠历史快照，
 * 渲染静态消息列表，无输入框/无发送/无流式状态。
 */
export default function ArchiveViewer({ sessionId, title }: Props) {
  const [archive, setArchive] = useState<ArchiveState>(emptyArchive)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    void window.__desktop__.getVersion().then((v) => setAppVersion(v))
  }, [])

  useEffect(() => {
    let alive = true
    setArchive(emptyArchive)
    setLoading(true)
    setError(null)
    ;(async () => {
      const histRes = await harness.getHistory(sessionId)
      if (!alive) return
      if (histRes.ok) {
        let state = emptyArchive
        for (const evt of histRes.value!.events) state = archiveReducer(state, evt)
        setArchive(state)
        // 回写标题到本地归档元数据：归档列表标题依赖此缓存，历史里的 session/title
        // 事件是标题的唯一可靠来源（归档后 session.list 不再返回）。
        const resolvedTitle = state.title && state.title !== '归档会话' ? state.title : title
        if (resolvedTitle) {
          const stateRes = await harness.getAppState()
          if (stateRes.ok && stateRes.value) {
            const meta = stateRes.value.archivedSessionMeta ?? {}
            const cur = meta[sessionId]
            if (!cur || !cur.title) {
              await harness.updateAppSettings({
                archivedSessionMeta: {
                  ...meta,
                  [sessionId]: { title: resolvedTitle, cwd: cur?.cwd, archivedAt: cur?.archivedAt },
                },
              })
            }
          }
        }
      } else {
        setError(histRes.error?.message ?? '历史加载失败')
      }
      setLoading(false)
    })()

    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const messages: ChatMessage[] = archive.messages

  return (
    <main className="chat-view archive-viewer">
      <header className="chat-header">
        <div className="chat-title">{archive.title || title || '归档会话'}</div>
        <div className="chat-header-right">
          <span className="chat-header-brand" title={`harness desktop v${appVersion || '0.1.0'}`}>
            <WhaleLogo className="chat-header-brand-logo" />
            <span className="chat-header-brand-text">归档会话（只读）</span>
          </span>
        </div>
      </header>

      {error && <div className="chat-error">{error}</div>}

      <div className="chat-columns">
        <div className="chat-center">
          <MessageList messages={messages} running={false} loading={loading} autoScroll={false} />
        </div>
      </div>
    </main>
  )
}
