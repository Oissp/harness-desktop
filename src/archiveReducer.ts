/**
 * src/archiveReducer.ts —— 归档历史专用折叠器：只处理完整消息，不处理流式增量。
 *
 * 归档会话的历史快照包含完整的 assistant/message 事件，不应走实时 chatReducer
 * 的 streaming 状态机（assistant-start → delta → assistant-end），否则会因
 * step/start 产生的 assistant-start 与 assistant/message 的 assistant-end
 * 状态不匹配导致重复/乱序/卡 streaming 状态。
 */
import type { ChatMessage, MessageBlock, SessionStreamEvent } from '../shared/types'

export interface ArchiveState {
  messages: ChatMessage[]
  title: string
}

export const emptyArchive: ArchiveState = {
  messages: [],
  title: '归档会话',
}

/**
 * 归档折叠器：只处理完整消息事件（user-message、assistant-end、tool-call、tool-result、title），
 * 跳过流式事件（assistant-start、assistant-delta）和元事件（running、turn-end）。
 */
export function archiveReducer(state: ArchiveState, evt: SessionStreamEvent): ArchiveState {
  switch (evt.kind) {
    case 'user-message': {
      const msg: ChatMessage = {
        id: evt.message.id,
        role: 'user',
        blocks: evt.message.blocks.length ? evt.message.blocks : [{ type: 'text', text: '' }],
        status: 'complete',
      }
      return { ...state, messages: [...state.messages, msg] }
    }

    case 'assistant-end': {
      const blocks = evt.message.blocks.length ? evt.message.blocks : []
      const msg: ChatMessage = {
        id: evt.message.id,
        role: 'assistant',
        blocks: blocks.length ? blocks : [{ type: 'text', text: '' }],
        status: evt.error ? 'error' : 'complete',
        error: evt.error,
      }
      return { ...state, messages: [...state.messages, msg] }
    }

    case 'tool-call': {
      const block: MessageBlock = {
        type: 'tool-call',
        id: evt.callId,
        name: evt.name,
        arguments: evt.arguments,
      }
      // tool-call 追加到最后一条 assistant 消息（如果有）
      const last = state.messages[state.messages.length - 1]
      if (last && last.role === 'assistant') {
        const updated = [...state.messages]
        updated[updated.length - 1] = { ...last, blocks: [...last.blocks, block] }
        return { ...state, messages: updated }
      }
      // 无 assistant 消息时（异常情况），新建一条
      const msg: ChatMessage = {
        id: `t-${evt.callId}`,
        role: 'assistant',
        blocks: [block],
        status: 'complete',
      }
      return { ...state, messages: [...state.messages, msg] }
    }

    case 'tool-result': {
      const block: MessageBlock = {
        type: 'tool-result',
        callId: evt.callId,
        content: evt.content,
      }
      // tool-result 独立成一条 user 消息
      const msg: ChatMessage = {
        id: `r-${evt.callId}`,
        role: 'user',
        blocks: [block],
        status: 'complete',
      }
      return { ...state, messages: [...state.messages, msg] }
    }

    case 'title': {
      return { ...state, title: evt.title }
    }

    // 跳过流式事件和元事件
    case 'assistant-start':
    case 'assistant-delta':
    case 'optimistic-user':
    case 'replace-user-text':
    case 'running':
    case 'turn-end':
    case 'step-end':
    case 'session-subscribed':
    case 'projection':
      return state

    default:
      return state
  }
}
