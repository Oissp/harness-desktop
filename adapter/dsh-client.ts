/**
 * adapter/dsh-client.ts —— 低层传输客户端（alpha.2 Typert Remote 协议）。
 *
 * dsh v0.1.2-alpha.2 移除了旧的 host-apiproxy（dotted method JSON-RPC + events.mux），
 * 改为 Typert Remote 网关：
 *  - 一元 RPC：POST /api/<namespace>/<method>，body {type:'client-request', rpcId, method, payload:{args}}
 *    响应 {type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error:{code,message,details}}}
 *  - 流：WebSocket /api/remote.mux，open{item}/end/error 帧（多路复用多个流）
 *  - 强制浏览器认证：启动 URL 携带 ?token=，GET /?token= → 303 + Set-Cookie，
 *    所有 /api/* 请求（含 WS 握手）都必须带该 Cookie。
 *
 * 本文件只负责传输与信封，不包含业务语义。
 */
import { randomUUID } from 'node:crypto'
import { fetchWithTimeout } from '../shared/fetch-timeout.js'

export interface RpcRequest {
  type: 'client-request'
  rpcId: string
  method: string
  payload: { args: Record<string, unknown> }
}

export interface RpcResponse<T = unknown> {
  type: 'server-response'
  rpcId: string
  result: RpcResult<T>
}

export interface RpcResult<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string; details?: Record<string, unknown> }
}

export class DshTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DshTransportError'
  }
}

let rpcCounter = 0
export function nextRpcId(): string {
  rpcCounter += 1
  return `hd-${Date.now().toString(36)}-${rpcCounter}`
}

/**
 * 一个远端流（remote.mux 上的逻辑流）。
 * 帧先入队；`first()` 取首个帧（用于 follow 的 snapshot），之后 `onItem` 持续接收后续帧。
 */
export class RemoteStream {
  private queue: unknown[] = []
  private waiters: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = []
  private settled: Error | null = null
  /** 首个帧消费后设置：后续每个 item 都会回调。 */
  onItem: ((value: unknown) => void) | null = null

  constructor(readonly id: string, readonly endpoint: string, readonly args: Record<string, unknown>) {}

  push(value: unknown) {
    if (this.settled) return
    if (this.waiters.length > 0) {
      this.waiters.shift()!.resolve(value)
      return
    }
    if (this.onItem) this.onItem(value)
    else this.queue.push(value)
  }

  end() {
    this.settled = this.settled ?? new Error(`远端流结束（${this.endpoint}）`)
    for (const w of this.waiters.splice(0)) w.reject(this.settled)
  }

  fail(error: Error) {
    this.settled = this.settled ?? error
    for (const w of this.waiters.splice(0)) w.reject(this.settled)
  }

  /** 取队列中的首个帧；流已结束则抛错。 */
  async first(timeoutMs = 15_000): Promise<unknown> {
    if (this.queue.length > 0) return this.queue.shift()!
    if (this.settled) throw this.settled
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      const waiter = {
        resolve: (v: unknown) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e: Error) => {
          clearTimeout(timer)
          reject(e)
        },
      }
      this.waiters.push(waiter)
      timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter)
        if (idx >= 0) this.waiters.splice(idx, 1)
        reject(new Error(`等待远端流首帧超时（${this.endpoint}）`))
      }, timeoutMs)
    })
  }
}

/**
 * remote.mux WebSocket 多路复用客户端。
 * 一条 WS 承载多个流；断线自动重连并重开所有活跃流。
 */
export class RemoteMuxClient {
  private ws: WebSocket | null = null
  private streams = new Map<string, RemoteStream>()
  private stopped = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly baseUrl: string,
    private readonly cookie: () => string | null,
  ) {}

  open(endpoint: string, args: Record<string, unknown>): RemoteStream {
    const streamId = randomUUID()
    const stream = new RemoteStream(streamId, endpoint, args)
    this.streams.set(streamId, stream)
    this.ensureSocket()
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendOpen(stream)
    } else {
      // 等 onopen 统一重开
      this.pendingOpens.push(stream)
    }
    return stream
  }

  private pendingOpens: RemoteStream[] = []

  private sendOpen(stream: RemoteStream) {
    this.ws?.send(JSON.stringify({ type: 'open', streamId: stream.id, endpoint: stream.endpoint, payload: { args: stream.args } }))
  }

  cancel(stream: RemoteStream) {
    this.streams.delete(stream.id)
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'cancel', streamId: stream.id }))
    }
    stream.end()
  }

  private ensureSocket() {
    if (this.stopped || this.ws) return
    const cookie = this.cookie()
    // Node ≥22 全局 WebSocket（undici）支持 { headers }；DOM 类型不声明该选项，显式断言。
    const WsCtor = WebSocket as unknown as {
      new (url: string, options?: { headers?: Record<string, string> }): WebSocket
    }
    const ws = new WsCtor(`ws://127.0.0.1:${new URL(this.baseUrl).port}/api/remote.mux`, cookie ? { headers: { cookie } } : undefined)
    this.ws = ws

    ws.onopen = () => {
      const pending = this.pendingOpens.splice(0)
      for (const p of pending) this.sendOpen(p)
    }

    ws.onmessage = (ev) => {
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(ev.data as string) as Record<string, unknown>
      } catch {
        return
      }
      const streamId = typeof frame.streamId === 'string' ? frame.streamId : ''
      const stream = this.streams.get(streamId)
      if (!stream) return
      if (frame.type === 'item') {
        stream.push(frame.value)
      } else if (frame.type === 'end') {
        this.streams.delete(streamId)
        stream.end()
      } else if (frame.type === 'error') {
        this.streams.delete(streamId)
        const err = (frame.error ?? {}) as { message?: string; code?: string }
        stream.fail(new Error(`远端流错误 ${stream.endpoint}${err.code ? ` (${err.code})` : ''}: ${err.message ?? '未知错误'}`))
      }
    }

    ws.onclose = () => {
      if (this.ws === ws) this.ws = null
      // 断线：活跃流挂起，重连后重新 open
      // （避免重复入队：认证前 401 断开时 pendingOpens 尚未被 onopen 清空）
      if (!this.stopped) {
        for (const stream of this.streams.values()) {
          if (!this.pendingOpens.includes(stream)) this.pendingOpens.push(stream)
        }
        this.reconnectTimer = setTimeout(() => this.ensureSocket(), 2000)
      }
    }

    ws.onerror = () => {
      ws.close()
    }
  }

  close() {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }
    for (const stream of this.streams.values()) stream.end()
    this.streams.clear()
    this.pendingOpens = []
  }
}

/**
 * 低层传输客户端：unary RPC 的 HTTP POST + remote.mux 流。
 * 不包含业务语义。
 */
export class DshClient {
  private baseUrl: string
  private authCookie: string | null = null
  private mux: RemoteMuxClient | null = null
  /** 引擎版本（dsh package.json），由宿主注入（adapter 无法自行定位打包路径）。 */
  private engineVersion: string | null = null

  constructor(port: number) {
    this.baseUrl = `http://127.0.0.1:${port}`
  }

  get port(): number {
    return Number(new URL(this.baseUrl).port)
  }

  /** 是否已完成浏览器认证（拿到会话 Cookie）。 */
  get authenticated(): boolean {
    return this.authCookie !== null
  }

  /** 注入引擎版本（供 describe 使用）。 */
  setVersion(version: string | null) {
    this.engineVersion = version
  }

  /**
   * 用进程启动令牌换取会话 Cookie：GET /?token=X → 303 + Set-Cookie（不跟随重定向）。
   * 成功返回 cookie 的 "name=value" 段；失败返回 null（引擎尚未就绪/令牌无效）。
   */
  async exchangeToken(token: string): Promise<boolean> {
    try {
      // establishAuth 在外层以 READY_TIMEOUT_MS（90s）为总预算重试本方法；若单次超时设得
      // 太短（曾用 10s），引擎认证接口只是偏慢而非假死时，会在总预算耗尽前被"超时→重试"
      // 自我消耗掉，而非真正等到认证成功。与 request() 的 30s 对齐，给慢但存活的场景留够空间。
      const res = await fetchWithTimeout(`${this.baseUrl}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' }, 30_000)
      if (res.status !== 303) return false
      const setCookie = res.headers.get('set-cookie') ?? res.headers.get('Set-Cookie') ?? ''
      const m = /^([^;=]+)=([^;]*)/.exec(setCookie.trim())
      if (!m) return false
      this.authCookie = `${m[1]}=${m[2]}`
      return true
    } catch {
      return false
    }
  }

  private async request<T>(method: string, args: Record<string, unknown>): Promise<T> {
    if (!this.authCookie) {
      throw new DshTransportError('未完成引擎认证（缺少会话 Cookie）')
    }
    const rpcId = nextRpcId()
    const body: RpcRequest = { type: 'client-request', rpcId, method, payload: { args } }
    let res: Response
    try {
      // 加超时：引擎假死时裸 fetch 会永久挂起，连带 IPC/UI 无响应
      res = await fetchWithTimeout(
        `${this.baseUrl}/api/${method}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: this.authCookie },
          body: JSON.stringify(body),
        },
        30_000,
      )
    } catch (err) {
      throw new DshTransportError(`dsh 通信失败（${method}）: ${(err as Error).message}`)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new DshTransportError(`dsh HTTP ${res.status} for ${method}: ${text.slice(0, 200)}`)
    }
    const data = (await res.json()) as RpcResponse<T>
    if (data.type !== 'server-response') {
      throw new DshTransportError(`dsh 返回了意外的消息类型: ${data.type}`)
    }
    if (!data.result.ok) {
      const err = data.result.error ?? { code: 'unknown', message: '未知错误' }
      const e = new Error(err.message) as Error & { code?: string }
      ;(e as { code?: string }).code = err.code
      throw e
    }
    return data.result.value as T
  }

  /** 打开一个远端流（走 remote.mux）。 */
  openStream(endpoint: string, args: Record<string, unknown>): RemoteStream {
    if (!this.mux) {
      this.mux = new RemoteMuxClient(this.baseUrl, () => this.authCookie)
    }
    return this.mux.open(endpoint, args)
  }

  /** 取消一个远端流（发送 cancel 帧）。 */
  muxCancel(stream: RemoteStream) {
    this.mux?.cancel(stream)
  }

  /** 就绪探测：发起一次无需业务状态的认证请求。 */
  async probeReady(): Promise<boolean> {
    if (!this.authCookie) return false
    try {
      await this.request('session/modelCatalog', {})
      return true
    } catch {
      return false
    }
  }

  // ---- 业务方法（薄封装：参数按 descriptor 的 wire 名包进 args） ----

  describeHost(): Promise<{
    version: string | null
    cwd: string | null
    provider?: string
    model?: string
    attachedSessions: number
    canOpenPath: boolean
  }> {
    return this.summarize()
  }

  private async summarize(): Promise<{
    version: string | null
    cwd: string | null
    provider?: string
    model?: string
    attachedSessions: number
    canOpenPath: boolean
  }> {
    let provider: string | undefined
    let model: string | undefined
    let attachedSessions = 0
    let canOpenPath = false
    try {
      const catalog = await this.request<{ default?: { provider?: string; model?: string } }>('session/modelCatalog', {})
      provider = catalog.default?.provider
      model = catalog.default?.model
    } catch {
      // 目录不可用不影响描述
    }
    try {
      const list = await this.request<{ items?: unknown[] }>('session/list', { _request: {} })
      attachedSessions = Array.isArray(list.items) ? list.items.length : 0
    } catch {
      // 列表不可用不影响描述
    }
    try {
      canOpenPath = Boolean(await this.request<boolean>('session/canOpenWorkspacePath', {}))
    } catch {
      // 忽略
    }
    return { version: this.engineVersion, cwd: null, provider, model, attachedSessions, canOpenPath }
  }

  listSessions(): Promise<{ items: unknown[] }> {
    return this.request('session/list', { _request: {} })
  }

  createSession(payload: { workspaceId?: string; cwd?: string; sessionId?: string; agentPreset?: string }): Promise<{ sessionId: string; agentPreset?: string }> {
    return this.request('session/create', { request: payload })
  }

  /** 打开 follow 流并返回其句柄；首帧为 snapshot（含完整历史 records）。 */
  followSession(sessionId: string, maxMessages = 500): RemoteStream {
    return this.openStream('session/follow', {
      request: { address: { kind: 'session', sessionId }, maxMessages },
    })
  }

  prompt(payload: { sessionId: string; mode: 'queue' | 'steer'; content: unknown[]; clientTimeZone?: string }): Promise<{ accepted: boolean }> {
    return this.request('session/prompt', {
      request: { requestId: randomUUID(), ...payload },
    })
  }

  cancel(payload: { sessionId: string }): Promise<{ accepted: boolean }> {
    return this.request('session/cancel', { request: payload })
  }

  /**
   * 执行一条斜杠命令（commands/execute）：不经模型、不进对话流，
   * 引擎侧追加 command/run → command/done 生命周期。
   * 用于 /plan 等主机命令——避免把命令当用户消息发给模型（污染对话）。
   * 返回 undefined 表示命令名/语法未命中（未进 handler）。
   */
  executeCommand(payload: { sessionId: string; line: string; images?: unknown[] }): Promise<unknown> {
    return this.request('commands/execute', {
      agentId: payload.sessionId,
      line: payload.line,
      images: payload.images ?? [],
    })
  }

  rename(payload: { sessionId: string; title: string }): Promise<{ title: string; seq: number }> {
    return this.request('session/rename', { request: payload })
  }

  fork(payload: { sessionId: string; atSeq?: number }): Promise<{ sessionId: string }> {
    return this.request('session/fork', { request: payload })
  }

  archiveSession(payload: { sessionId: string }): Promise<{ archivedSessionIds: string[] }> {
    return this.request('workspace/archiveSession', { request: payload })
  }

  modelCatalog(): Promise<{
    default: { provider: string; model: string; reasoningEffort?: string }
    routableProviders: string[]
    groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string; description?: string; reasoning?: unknown }> }>
    failures: unknown[]
  }> {
    return this.request('session/modelCatalog', {})
  }

  selectModel(payload: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Promise<unknown> {
    return this.request('session/selectModel', { request: payload })
  }

  credentialsDescribe(payload: { refs: string[] }): Promise<{ credentials: Record<string, { configured: boolean; source?: string; writable?: boolean }> }> {
    return this.request('credentials/describe', payload)
  }

  credentialsSet(payload: { ref: string; value: string }): Promise<void> {
    return this.request('credentials/set', payload)
  }

  credentialsUnset(payload: { ref: string }): Promise<void> {
    return this.request('credentials/unset', payload)
  }

  settingsDescribe(): Promise<{
    writable: boolean
    hasDocument: boolean
    namespaces: Array<{ ns: string; value: Record<string, unknown>; secrets: unknown[]; applies?: string; revision?: number }>
  }> {
    return this.request('settings/describe', {})
  }

  settingsUpdate(payload: { ns: string; patch: Record<string, unknown>; expectedRevision?: number }): Promise<unknown> {
    return this.request('settings/update', payload)
  }

  settingsMutate(payload: { ns: string; ops: unknown[]; expectedRevision?: number }): Promise<unknown> {
    return this.request('settings/mutate', payload)
  }

  agentPresetList(): Promise<{ presets: unknown[]; authorable: boolean }> {
    return this.request('agentPresets/list', {})
  }

  agentPresetSelect(payload: { sessionId: string; agentPreset: string }): Promise<string> {
    return this.request('agentPresets/select', {
      agentId: payload.sessionId,
      agentPreset: payload.agentPreset,
    })
  }

  skillsList(payload: { sessionId: string }): Promise<{ skills: unknown[] }> {
    return this.request('skills/list', { request: payload })
  }

  pickDirectory(): Promise<string | null> {
    return this.request('directoryPicker/pick', {})
  }

  close() {
    this.mux?.close()
    this.mux = null
  }
}
