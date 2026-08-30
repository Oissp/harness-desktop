/**
 * adapter/events.ts —— 把 dsh 的 SessionEvent / remote.mux 帧归一化为稳定的
 * SessionStreamEvent 词汇。dsh 改事件名/字段时只需改这里。
 *
 * alpha.2 帧来源：
 *  - session/control 流：baseline / queue / jobs / projection 帧（全局会话状态）
 *  - session/follow 流：首帧 snapshot（历史）之后是 event 帧（实时聊天事件）
 */
import type { MessageBlock, SessionStreamEvent } from '../shared/types.js'

/** dsh 事件的最小结构（宽松类型，做防御性解析）。 */
export interface DshEvent {
  type: string
  seq: number
  time?: number
  data?: Record<string, unknown>
}

interface DshChunk {
  type?: string
  text?: string
  reason?: { kind?: string; error?: { message?: string }; failure?: { message?: string } }
}

function asText(blocks: unknown[] | undefined): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
    .map((b) => {
      if (b.type === 'text' && typeof b.text === 'string') return b.text
      return ''
    })
    .join('')
}

function asMessageBlocks(blocks: unknown[] | undefined): MessageBlock[] {
  if (!Array.isArray(blocks)) return []
  const out: MessageBlock[] = []
  for (const raw of blocks) {
    if (typeof raw !== 'object' || raw === null) continue
    const b = raw as Record<string, unknown>
    switch (b.type) {
      case 'text': {
        if (typeof b.text === 'string') out.push({ type: 'text', text: b.text })
        break
      }
      case 'reasoning': {
        if (typeof b.text === 'string') out.push({ type: 'reasoning', text: b.text })
        break
      }
      case 'tool-call': {
        out.push({
          type: 'tool-call',
          id: String(b.id ?? ''),
          name: String(b.name ?? ''),
          arguments: String(b.arguments ?? ''),
        })
        break
      }
      case 'tool-result': {
        out.push({
          type: 'tool-result',
          callId: String((b as { toolCallId?: unknown }).toolCallId ?? ''),
          content: asMessageBlocks(b.content as unknown[] | undefined),
          isError: Boolean((b as { isError?: unknown }).isError),
        })
        break
      }
      case 'image': {
        // 图片块不展开，仅占位提示
        out.push({ type: 'text', text: '[图片]' })
        break
      }
      default:
        break
    }
  }
  return out
}

/** 归一化一条 dsh SessionEvent → 0..n 条稳定事件。 */
export function normalizeSessionEvent(
  sessionId: string,
  raw: DshEvent,
): SessionStreamEvent[] {
  const evt = raw as DshEvent & Record<string, unknown>
  const data = (evt.data ?? {}) as Record<string, unknown>
  const seq = evt.seq
  const out: SessionStreamEvent[] = []

  switch (evt.type) {
    case 'user/message': {
      // 只展示真正的用户消息（source.kind === 'user'）；runtime-context 等
      // 引擎注入的 plugin 消息不进入聊天界面。
      const source = (data.source ?? {}) as { kind?: string }
      if (source.kind !== 'user') break
      const id = typeof data.id === 'string' ? data.id : `u${seq}`
      out.push({
        kind: 'user-message',
        sessionId,
        seq,
        message: { id, blocks: asMessageBlocks(data.content as unknown[]) },
      })
      break
    }
    case 'turn/start': {
      out.push({
        kind: 'assistant-start',
        sessionId,
        seq,
        turn: Number(data.turn ?? 1),
        step: Number(data.step ?? 1),
      })
      out.push({ kind: 'running', sessionId, running: true })
      break
    }
    case 'step/start': {
      out.push({
        kind: 'assistant-start',
        sessionId,
        seq,
        turn: Number(data.turn ?? 1),
        step: Number(data.step ?? 1),
      })
      break
    }
    case 'step/end': {
      out.push({
        kind: 'step-end',
        sessionId,
        seq,
        turn: Number(data.turn ?? 1),
        step: Number(data.step ?? 1),
        time: Number(evt.time ?? Date.now()),
      })
      break
    }
    case 'turn/end': {
      const reasonRaw = (data.reason ?? {}) as { kind?: string; error?: { message?: string } }
      out.push({
        kind: 'turn-end',
        sessionId,
        seq,
        turn: Number(data.turn ?? 1),
        time: Number(evt.time ?? Date.now()),
        reason: reasonRaw.kind === 'completed' ? 'completed' : reasonRaw.kind === 'error' ? 'error' : 'stopped',
        error: reasonRaw.error?.message,
        usage: (data.usage as { inputTokens?: number; outputTokens?: number } | undefined) ?? undefined,
      })
      // 回合结束 → running:false（思考完成/转圈停止的关键）
      out.push({ kind: 'running', sessionId, running: false })
      break
    }
    case 'assistant/chunk': {
      const chunk = (data.chunk ?? {}) as DshChunk
      const turn = Number(data.turn ?? 1)
      const step = Number(data.step ?? 1)
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        out.push({ kind: 'assistant-delta', sessionId, seq, turn, step, text: chunk.text, reasoning: false })
      } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        out.push({ kind: 'assistant-delta', sessionId, seq, turn, step, text: chunk.text, reasoning: true })
      } else if (chunk.type === 'finish') {
        const err = chunk.reason?.error?.message ?? chunk.reason?.failure?.message
        if (err) {
          out.push({ kind: 'assistant-end', sessionId, seq, turn, step, message: { id: `a-${turn}-${step}`, blocks: [] }, error: err })
        }
      }
      break
    }
    case 'assistant/message': {
      const msg = (data.message ?? {}) as Record<string, unknown>
      out.push({
        kind: 'assistant-end',
        sessionId,
        seq,
        turn: Number(data.turn ?? 1),
        step: Number(data.step ?? 1),
        message: {
          id: typeof msg.id === 'string' ? msg.id : `a-${data.turn}-${data.step}`,
          blocks: asMessageBlocks(msg.content as unknown[]),
        },
      })
      break
    }
    case 'tool/call': {
      out.push({
        kind: 'tool-call',
        sessionId,
        seq,
        callId: String(data.callId ?? ''),
        name: String(data.name ?? ''),
        arguments: String(data.arguments ?? ''),
      })
      break
    }
    case 'tool/result': {
      const msg = (data.message ?? {}) as Record<string, unknown>
      out.push({
        kind: 'tool-result',
        sessionId,
        seq,
        callId: String(data.callId ?? ''),
        content: asMessageBlocks(msg.content as unknown[]),
        isError: Boolean((data.error as { code?: string })?.code),
        name: typeof msg.name === 'string' ? msg.name : undefined,
      })
      break
    }
    case 'session/title': {
      const title = typeof data.title === 'string' ? data.title : ''
      out.push({ kind: 'title', sessionId, seq, title })
      break
    }
    default:
      break
  }
  return out
}

/** 归一化一条 session/control 流帧（全局会话状态）→ 稳定事件。 */
export function normalizeControlFrame(frame: Record<string, unknown>): SessionStreamEvent[] {
  const out: SessionStreamEvent[] = []
  switch (frame.type) {
    case 'baseline': {
      const value = (frame.value ?? {}) as {
        queues?: Record<string, Array<{ placement?: string }>>
        jobs?: Record<string, Array<{ status?: string }>>
        projections?: Record<string, { asOfSeq?: number; values?: Record<string, unknown> }>
      }
      const projections = value.projections ?? {}
      for (const [agentId, proj] of Object.entries(projections)) {
        if (!proj) continue
        const seq = Number(proj.asOfSeq ?? -1)
        out.push({ kind: 'session-subscribed', sessionId: agentId, lastSeq: seq })
        const values = proj.values ?? {}
        if (typeof values.title === 'string' && values.title) {
          out.push({ kind: 'title', sessionId: agentId, seq, title: values.title })
        }
        for (const [key, v] of Object.entries(values)) {
          out.push({ kind: 'projection', sessionId: agentId, seq, key, value: v })
        }
        const busy =
          (value.queues?.[agentId] ?? []).some((it) => it.placement === 'queued' || it.placement === 'steering') ||
          (value.jobs?.[agentId] ?? []).some((j) => j.status === 'running' || j.status === 'stopping')
        if (busy) out.push({ kind: 'running', sessionId: agentId, running: true })
      }
      break
    }
    case 'queue': {
      const sessionId = String(frame.sessionId ?? '')
      const items = (frame.items ?? []) as Array<{ placement?: string }>
      if (sessionId && items.some((it) => it.placement === 'queued' || it.placement === 'steering')) {
        out.push({ kind: 'running', sessionId, running: true })
      }
      break
    }
    case 'jobs': {
      const sessionId = String(frame.sessionId ?? '')
      const jobs = (frame.jobs ?? []) as Array<{ status?: string }>
      if (sessionId) {
        out.push({ kind: 'running', sessionId, running: jobs.some((j) => j.status === 'running' || j.status === 'stopping') })
      }
      break
    }
    case 'projection': {
      const sessionId = String(frame.sessionId ?? '')
      const key = String(frame.key ?? '')
      const seq = Number(frame.seq ?? -1)
      out.push({ kind: 'projection', sessionId, seq, key, value: frame.value })
      if (key === 'title' && typeof frame.value === 'string') {
        out.push({ kind: 'title', sessionId, seq, title: frame.value })
      }
      break
    }
    default:
      break
  }
  return out
}

/** 归一化一条 session/follow 流帧（实时聊天事件）。snapshot 由 adapter 单独消费（历史）。 */
export function normalizeFollowFrame(sessionId: string, frame: Record<string, unknown>): SessionStreamEvent[] {
  if (frame.type === 'event') {
    const event = frame.event as DshEvent | undefined
    if (!event || typeof event.type !== 'string') return []
    return normalizeSessionEvent(sessionId, event)
  }
  return []
}

/** 归一化 session.follow snapshot / session.page 的一页历史。 */
export function normalizeHistory(events: unknown[]): SessionStreamEvent[] {
  const out: SessionStreamEvent[] = []
  for (const entry of events) {
    const event = (entry as { event?: DshEvent }).event ?? (entry as DshEvent)
    const obj = event as unknown as Record<string, unknown>
    const sessionId = typeof event === 'object' && event !== null && 'sessionId' in obj
      ? String(obj.sessionId ?? '')
      : ''
    out.push(...normalizeSessionEvent(sessionId, event as DshEvent))
  }
  return out
}

export { asText }
