/// <reference types="vite/client" />
import type { HarnessApi } from '../shared/types'

declare global {
  interface Window {
    harness: HarnessApi
    /** 026/028 __desktop__ 桥：桌面壳能力（官方 UI 与回退页共用）。 */
    __desktop__: {
      getPort(): Promise<number | null>
      getVersion(): Promise<string>
      notify(title: string, body: string): Promise<void>
      /** 归档会话列表（含本地缓存的标题/cwd 元数据合并）。 */
      listArchived(): Promise<import('../shared/types').ArchivedSessionInfo[]>
      /** 硬删除会话（连同磁盘目录）。 */
      hardDeleteSession(sessionId: string, cwd?: string): Promise<boolean>
      /** 在只读窗口打开归档会话查看历史内容。 */
      openArchiveViewer(sessionId: string, title?: string): Promise<void>
      onEnginePort(cb: (port: number | null) => void): () => void
      onMenuEvent(cb: (action: 'new-chat' | 'open-settings') => void): () => void
    }
  }
}

export {}
