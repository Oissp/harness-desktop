import { describe, expect, it } from 'vitest'
import { normalizeSessionEvent, normalizeControlFrame, normalizeFollowFrame } from '../events'
import type { DshEvent } from '../events'

const base = { sessionId: 's1', seq: 1, time: 0 }

describe('adapter/events normalizeSessionEvent', () => {
  it('assistant/chunk text-delta → assistant-delta', () => {
    const raw = {
      ...base,
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: '你好' } },
    } as unknown as DshEvent
    const out = normalizeSessionEvent('s1', raw)
    expect(out).toContainEqual({
      kind: 'assistant-delta',
      sessionId: 's1',
      seq: 1,
      turn: 1,
      step: 1,
      text: '你好',
      reasoning: false,
    })
  })

  it('assistant/chunk reasoning-delta → assistant-delta reasoning:true', () => {
    const raw = {
      ...base,
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: '想' } },
    } as unknown as DshEvent
    const out = normalizeSessionEvent('s1', raw)
    expect(out[0]).toMatchObject({ kind: 'assistant-delta', reasoning: true, text: '想' })
  })

  it('assistant/chunk finish error → assistant-end error', () => {
    const raw = {
      ...base,
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'error', error: { message: '模型挂了' } } } },
    } as unknown as DshEvent
    const out = normalizeSessionEvent('s1', raw)
    expect(out[0]).toMatchObject({ kind: 'assistant-end', error: '模型挂了' })
  })

  it('turn/start → assistant-start + running（真实事件无 step 字段，归一化为 step=1）', () => {
    const raw = { ...base, type: 'turn/start', data: { turn: 1 } } as unknown as DshEvent
    const out = normalizeSessionEvent('s1', raw)
    expect(out[0]).toMatchObject({ kind: 'assistant-start', turn: 1, step: 1 })
    expect(out[1]).toMatchObject({ kind: 'running', running: true })
  })

  it('step/start → assistant-start（不触发 running）', () => {
    const raw = { ...base, type: 'step/start', data: { turn: 1, step: 1 } } as unknown as DshEvent
    const out = normalizeSessionEvent('s1', raw)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'assistant-start', turn: 1, step: 1 })
  })

  it('step/end → step-end', () => {
    const raw = { ...base, type: 'step/end', data: { turn: 1, step: 1 } } as unknown as DshEvent
    const out = normalizeSessionEvent('s1', raw)
    expect(out[0]).toMatchObject({ kind: 'step-end', turn: 1, step: 1 })
  })

  it('turn/end completed → turn-end completed', () => {
    const raw = {
      ...base,
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' }, usage: { inputTokens: 10, outputTokens: 20 } },
    } as unknown as DshEvent
    const out = normalizeSessionEvent('s1', raw)
    expect(out[0]).toMatchObject({ kind: 'turn-end', reason: 'completed', usage: { inputTokens: 10, outputTokens: 20 } })
  })

  it('turn/end error → turn-end error + message', () => {
    const raw = {
      ...base,
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } },
    } as unknown as DshEvent
    const out = normalizeSessionEvent('s1', raw)
    expect(out[0]).toMatchObject({ kind: 'turn-end', reason: 'error', error: 'boom' })
  })

  it('turn/end 同时推送 running:false（思考/转圈结束）', () => {
    const raw = {
      ...base,
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    } as unknown as DshEvent
    const out = normalizeSessionEvent('s1', raw)
    expect(out[1]).toMatchObject({ kind: 'running', running: false })
  })

  it('user/message 仅 source.kind=user 通过', () => {
    const raw = {
      ...base,
      type: 'user/message',
      data: { id: 'u1', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
    } as unknown as DshEvent
    const out = normalizeSessionEvent('s1', raw)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('user-message')
  })

  it('runtime-context 等注入消息被过滤', () => {
    const raw = {
      ...base,
      type: 'user/message',
      data: { id: 'u2', content: [{ type: 'text', text: 'runtime' }], source: { kind: 'plugin' } },
    } as unknown as DshEvent
    const out = normalizeSessionEvent('s1', raw)
    expect(out).toHaveLength(0)
  })
})

describe('adapter/events normalizeControlFrame', () => {
  it('baseline 帧 → session-subscribed + title + projection（含 running）', () => {
    const frame = {
      type: 'baseline',
      value: {
        queues: { s1: [{ placement: 'queued' }] },
        jobs: {},
        projections: {
          s1: {
            asOfSeq: 5,
            values: { title: '我的会话', agentPreset: 'desktop' },
          },
        },
      },
    }
    const out = normalizeControlFrame(frame as unknown as Record<string, unknown>)
    expect(out).toContainEqual({ kind: 'session-subscribed', sessionId: 's1', lastSeq: 5 })
    expect(out).toContainEqual({ kind: 'title', sessionId: 's1', seq: 5, title: '我的会话' })
    expect(out).toContainEqual({ kind: 'projection', sessionId: 's1', seq: 5, key: 'agentPreset', value: 'desktop' })
    expect(out).toContainEqual({ kind: 'running', sessionId: 's1', running: true })
  })

  it('queue 帧有 queued/steering → running:true', () => {
    const out = normalizeControlFrame({
      type: 'queue',
      sessionId: 's1',
      items: [{ placement: 'steering' }],
    })
    expect(out).toContainEqual({ kind: 'running', sessionId: 's1', running: true })
  })

  it('jobs 帧按状态推 running：有 running/stopping → true，否则 false', () => {
    const busy = normalizeControlFrame({ type: 'jobs', sessionId: 's1', jobs: [{ status: 'running' }] })
    expect(busy[0]).toMatchObject({ kind: 'running', running: true })
    const idle = normalizeControlFrame({ type: 'jobs', sessionId: 's1', jobs: [{ status: 'idle' }] })
    expect(idle[0]).toMatchObject({ kind: 'running', running: false })
  })

  it('projection 帧 key=title → title 事件', () => {
    const out = normalizeControlFrame({ type: 'projection', sessionId: 's1', key: 'title', value: '新标题', seq: 7 })
    expect(out).toContainEqual({ kind: 'title', sessionId: 's1', seq: 7, title: '新标题' })
  })

  it('未知帧类型 → 空数组', () => {
    expect(normalizeControlFrame({ type: 'nope' })).toHaveLength(0)
  })
})

describe('adapter/events normalizeFollowFrame', () => {
  it('event 帧 → 归一化聊天事件', () => {
    const frame = {
      type: 'event',
      event: { type: 'turn/start', seq: 3, time: 0, data: { turn: 1 } },
    }
    const out = normalizeFollowFrame('s1', frame as unknown as Record<string, unknown>)
    expect(out[0]).toMatchObject({ kind: 'assistant-start', sessionId: 's1' })
    expect(out[1]).toMatchObject({ kind: 'running', running: true })
  })

  it('snapshot 帧（adapter 单独消费为历史）→ 空数组', () => {
    const out = normalizeFollowFrame('s1', { type: 'snapshot', records: [] })
    expect(out).toHaveLength(0)
  })
})
