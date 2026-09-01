/**
 * adapter/index.ts —— 高层的稳定 API。
 *
 * 主进程通过这个类访问 dsh 的全部能力。dsh 上游变更只会影响
 * DshClient（dsh-client.ts）与 normalize*（events.ts），本文件尽量薄。
 */
import { DshClient, type RemoteStream } from './dsh-client.js'
import { normalizeControlFrame, normalizeFollowFrame, normalizeHistory } from './events.js'
import type { DshEvent } from './events.js'
import type {
  AgentPresetInfo,
  ArchivedSessionInfo,
  CredentialStatus,
  CustomProviderConfig,
  CustomProviderListItem,
  MessageBlock,
  ModelGroup,
  PickedFile,
  ProviderInfo,
  SessionStreamEvent,
  SessionSummary,
  SkillInfo,
  WebSearchConfig,
} from '../shared/types.js'

/** 从 provider id 生成一个环境变量风格的凭据引用，如 my-gateway → MY_GATEWAY_KEY。 */
function envRefFor(providerId: string): string {
  const base = providerId.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase()
  return `${base || 'CUSTOM'}_API_KEY`
}

function dispatch(listeners: ((evt: SessionStreamEvent) => void)[], evt: SessionStreamEvent) {
  for (const listener of [...listeners]) listener(evt)
}

export class DshAdapter {
  readonly client: DshClient
  /** 全局 session/control 流（会话列表状态）。 */
  private control: RemoteStream | null = null
  /** 已打开的 session/follow 流（sessionId → stream），为聊天视图提供实时事件。 */
  private follows = new Map<string, RemoteStream>()
  private eventListeners: ((evt: SessionStreamEvent) => void)[] = []

  constructor(port: number) {
    this.client = new DshClient(port)
  }

  /** 注入引擎版本（dsh package.json），describe 用。 */
  setVersion(version: string | null) {
    this.client.setVersion(version)
  }

  // ---- 生命周期 ----

  /** 就绪探测：认证完成 + 一次认证请求成功即视为就绪。 */
  async isReady(): Promise<boolean> {
    return this.client.probeReady()
  }

  describe(): Promise<{
    version: string | null
    cwd: string | null
    provider?: string
    model?: string
    attachedSessions: number
    canOpenPath: boolean
  }> {
    return this.client.describeHost()
  }

  // ---- 会话 ----

  async listSessions(): Promise<SessionSummary[]> {
    const { items } = await this.client.listSessions()
    // 去重：引擎可能因订阅/列表竞态返回重复 sessionId
    const seen = new Set<string>()
    return items
      .filter((raw) => {
        const id = String((raw as Record<string, unknown>).sessionId ?? '')
        if (!id || seen.has(id)) return false
        seen.add(id)
        return true
      })
      .map((raw) => {
        const s = raw as Record<string, unknown>
        // title / agentPreset 在 projections.values 里（值可能为 null 或字符串）
        const proj = (s.projections as { values?: Record<string, unknown> } | undefined)?.values
        const projTitle = proj?.title
        const resolvedTitle =
          typeof projTitle === 'string'
            ? projTitle
            : projTitle && typeof projTitle === 'object' && 'value' in projTitle
              ? (projTitle as { value?: unknown }).value
              : undefined
        const title = typeof resolvedTitle === 'string' ? resolvedTitle : (s.title as string)
        const agentPreset = typeof proj?.agentPreset === 'string' ? proj.agentPreset : undefined
        // 计划模式：goal 投影存在且未 complete（对应旧 projections.plan.active）
        const goal = proj?.goal as { goal?: { phase?: string } } | null | undefined
        const planActive = goal != null && goal.goal != null && goal.goal.phase !== 'complete'
        return {
          sessionId: String(s.sessionId ?? ''),
          title: title || '新会话',
          updatedAt: Number(s.updatedAt ?? 0),
          running: Boolean(s.running),
          blank: Boolean(s.blank),
          cwd: typeof s.cwd === 'string' ? s.cwd : undefined,
          agentPreset,
          planActive,
        }
      })
  }

  createSession(cwd?: string, agentPreset?: string): Promise<{ sessionId: string }> {
    const payload: { workspaceId?: string; cwd?: string; agentPreset?: string } = {}
    if (cwd) payload.cwd = cwd
    if (agentPreset) payload.agentPreset = agentPreset
    return this.client.createSession(payload)
  }

  /**
   * 拉取历史 + 建立该会话的实时事件流。
   * 通过 session/follow 流：首帧 snapshot 即完整历史，其后 event 帧持续推送实时事件。
   */
  async getHistory(sessionId: string): Promise<{ events: SessionStreamEvent[]; hasMore: boolean }> {
    const prev = this.follows.get(sessionId)
    if (prev) {
      prev.onItem = null
      this.client.muxCancel(prev)
      this.follows.delete(sessionId)
    }
    const stream = this.client.followSession(sessionId)
    this.follows.set(sessionId, stream)
    const first = (await stream.first()) as Record<string, unknown> | null | undefined
    // snapshot 之后的事件才推给监听器（snapshot 已作为历史返回）
    stream.onItem = (value) => {
      for (const evt of normalizeFollowFrame(sessionId, value as Record<string, unknown>)) {
        dispatch(this.eventListeners, evt)
      }
    }
    if (first && first.type === 'snapshot') {
      return {
        events: normalizeHistory((first.records as unknown[] | undefined) ?? []),
        hasMore: Boolean((first as { hasMore?: boolean }).hasMore),
      }
    }
    // 极端情况：首帧不是 snapshot（如会话无历史）——把它当实时事件分发
    if (first) {
      stream.onItem(first)
    }
    return { events: [], hasMore: false }
  }

  async sendMessage(sessionId: string, text: string, files?: PickedFile[]): Promise<{ accepted: boolean }> {
    const content: unknown[] = [{ type: 'text', text }]
    if (files && files.length > 0) {
      const images = files.filter((f) => f.data && f.mediaType)
      for (const img of images) {
        content.push({
          type: 'image',
          mediaType: img.mediaType,
          data: img.data,
          ...(img.name ? { name: img.name } : {}),
        })
      }
      const refs = files.filter((f) => !f.data)
      if (refs.length > 0) {
        content.push({
          type: 'text',
          text: `[已附加文件]\n${refs.map((f) => `- ${f.path}`).join('\n')}`,
        })
      }
    }
    return this.client.prompt({
      sessionId,
      mode: 'queue',
      content,
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
  }

  cancelTurn(sessionId: string): Promise<{ accepted: boolean }> {
    return this.client.cancel({ sessionId })
  }

  renameSession(sessionId: string, title: string): Promise<{ title: string }> {
    return this.client.rename({ sessionId, title })
  }

  forkSession(sessionId: string): Promise<{ sessionId: string }> {
    return this.client.fork({ sessionId })
  }

  archiveSession(sessionId: string): Promise<{ archivedSessionIds: string[] }> {
    return this.client.archiveSession({ sessionId })
  }

  /**
   * 拉取已归档会话：打开 workspace/follow 流，读首帧 baseline 后取消。
   * baseline.archivedSessionIds 即归档集合；各 workspace.sessionIds → path 映射给出 cwd（用于删除定位）。
   * 归档是持久的显示过滤器，会话数据仍在磁盘原位，故可通过 workspace 归属定位其目录。
   */
  async listArchivedSessions(): Promise<ArchivedSessionInfo[]> {
    const stream = this.client.workspaceFollow()
    let baseline: Record<string, unknown> | null = null
    try {
      const first = (await stream.first()) as Record<string, unknown> | null | undefined
      if (first && first.type === 'baseline') baseline = (first.value as Record<string, unknown>) ?? null
    } finally {
      stream.onItem = null
      this.client.muxCancel(stream)
    }
    if (!baseline) return []
    const archivedIds = (baseline.archivedSessionIds as unknown[] | undefined) ?? []
    // 构建 sessionId → workspace.path 映射（归档会话仍保留在其 workspace 的 sessionIds 中）
    const cwdBySession = new Map<string, string>()
    const items = (baseline.items as unknown[] | undefined) ?? []
    for (const w of items) {
      const ws = w as Record<string, unknown>
      const path = typeof ws.path === 'string' ? ws.path : undefined
      const ids = (ws.sessionIds as unknown[] | undefined) ?? []
      if (!path) continue
      for (const id of ids) {
        if (typeof id === 'string') cwdBySession.set(id, path)
      }
    }
    return archivedIds
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .map((sessionId) => ({
        sessionId,
        cwd: cwdBySession.get(sessionId),
      }))
  }

  // ---- Agent 预设（模式） ----

  async listSkills(sessionId: string): Promise<SkillInfo[]> {
    const res = await this.client.skillsList({ sessionId })
    return (res.skills ?? []).map((s) => {
      const sk = s as Record<string, unknown>
      return {
        name: String(sk.name ?? ''),
        description: String(sk.description ?? ''),
        whenToUse: typeof sk.whenToUse === 'string' ? sk.whenToUse : undefined,
        modelInvocable: Boolean(sk.modelInvocable),
      }
    })
  }

  async listAgentPresets(): Promise<AgentPresetInfo[]> {
    const res = await this.client.agentPresetList()
    return (res.presets ?? []).map((p) => {
      const preset = p as Record<string, unknown>
      return {
        id: String(preset.id ?? ''),
        name: String(preset.name ?? preset.id ?? ''),
        description: typeof preset.description === 'string' ? preset.description : undefined,
        isDefault: Boolean(preset.isDefault),
      }
    })
  }

  async selectAgentPreset(sessionId: string, agentPreset: string): Promise<{ agentPreset: string }> {
    const selected = await this.client.agentPresetSelect({ sessionId, agentPreset })
    return { agentPreset: String(selected ?? agentPreset) }
  }

  // ---- 模型 ----

  async listModels(): Promise<ModelGroup[]> {
    const { groups } = await this.client.modelCatalog()
    return (groups ?? []).map((g) => ({
      id: String(g.id ?? ''),
      name: String(g.name ?? g.id ?? ''),
      models: ((g.models as unknown[]) ?? []).map((m) => {
        const model = m as Record<string, unknown>
        return {
          id: String(model.id ?? ''),
          name: String(model.name ?? model.id ?? ''),
          description: typeof model.description === 'string' ? model.description : undefined,
        }
      }),
    }))
  }

  async listProviders(): Promise<ProviderInfo[]> {
    const { routableProviders } = await this.client.modelCatalog()
    return (routableProviders ?? []).map((id) => ({ id: String(id), name: String(id) }))
  }

  selectModel(sessionId: string, provider: string, model: string): Promise<unknown> {
    return this.client.selectModel({ sessionId, provider, model })
  }

  // ---- 凭据 / 设置 ----

  async hasApiKey(): Promise<boolean> {
    const { credentials } = await this.client.credentialsDescribe({
      refs: ['DEEPSEEK_API_KEY'],
    })
    const view = credentials['DEEPSEEK_API_KEY']
    return Boolean(view?.configured)
  }

  async setApiKey(key: string): Promise<void> {
    await this.client.credentialsSet({ ref: 'DEEPSEEK_API_KEY', value: key })
  }

  // ---- Part A：凭证统一管理 ----

  /** 枚举全部凭据 ref 及配置状态（来自 settings.describe 的命名空间）。 */
  async listCredentials(): Promise<CredentialStatus[]> {
    const describe = await this.client.settingsDescribe()
    const refs: Array<{ ref: string; label: string; priority: number }> = []
    const push = (ref: string, label: string, priority: number) => refs.push({ ref, label, priority })
    for (const ns of describe.namespaces) {
      const value = ns.value ?? {}
      if (ns.ns === 'llm-deepseek') {
        push(typeof value.apiKeyEnv === 'string' ? value.apiKeyEnv : 'DEEPSEEK_API_KEY', 'DeepSeek 官方', 0)
      } else if (ns.ns === 'web-search-deepseek') {
        push(typeof value.apiKeyEnv === 'string' ? value.apiKeyEnv : 'DEEPSEEK_API_KEY', 'Web 搜索', 2)
      } else if (ns.ns === 'llm-pi-ai') {
        const providers = (value.providers ?? {}) as Record<string, Record<string, unknown>>
        for (const [id, cfg] of Object.entries(providers)) {
          if (typeof cfg.apiKeyEnv === 'string' && cfg.apiKeyEnv.length > 0) {
            push(cfg.apiKeyEnv, String(cfg.displayName ?? id), 1)
          }
        }
      }
    }
    // 按 ref 去重，优先级高（数字小）的 label 胜出
    const byRef = new Map<string, { label: string; priority: number }>()
    for (const r of refs) {
      const cur = byRef.get(r.ref)
      if (!cur || r.priority < cur.priority) byRef.set(r.ref, { label: r.label, priority: r.priority })
    }
    const uniqRefs = [...byRef.entries()].map(([ref, v]) => ({ ref, label: v.label }))
    const { credentials } = await this.client.credentialsDescribe({ refs: uniqRefs.map((r) => r.ref) })
    return uniqRefs.map((r) => {
      const view = credentials[r.ref]
      return { ref: r.ref, label: r.label, configured: Boolean(view?.configured) }
    })
  }

  async setCredential(ref: string, value: string): Promise<void> {
    await this.client.credentialsSet({ ref, value })
  }

  async clearCredential(ref: string): Promise<void> {
    await this.client.credentialsUnset({ ref })
  }


  // ---- Part A：Web 搜索 ----

  async getWebSearchConfig(): Promise<WebSearchConfig> {
    const describe = await this.client.settingsDescribe()
    const ns = describe.namespaces.find((n) => n.ns === 'web-search-deepseek')
    const v = (ns?.value ?? {}) as Record<string, unknown>
    return {
      apiKeyEnv: typeof v.apiKeyEnv === 'string' ? v.apiKeyEnv : 'DEEPSEEK_API_KEY',
      model: typeof v.model === 'string' ? v.model : 'deepseek-v4-flash',
      apiVersion: typeof v.apiVersion === 'string' ? v.apiVersion : '2023-06-01',
      baseURL: typeof v.baseURL === 'string' ? v.baseURL : undefined,
      maxUses: typeof v.maxUses === 'number' ? v.maxUses : 5,
    }
  }

  async setWebSearchConfig(config: Partial<WebSearchConfig>): Promise<WebSearchConfig> {
    await this.client.settingsUpdate({ ns: 'web-search-deepseek', patch: config as Record<string, unknown> })
    return this.getWebSearchConfig()
  }

  /**
   * 计划模式：走 commands/execute 执行 /plan 主机命令。
   * 不经模型、不进对话流（引擎侧仅追加 command/run 生命周期），
   * 避免旧实现把 "/plan" 当用户消息发给模型污染对话。
   * executeCommand 返回 undefined 表示命令名/语法未命中——把这个信号透传给调用方，
   * 否则渲染层的乐观 UI 翻转在命令未生效时也无法回退。
   */
  async togglePlanMode(sessionId: string): Promise<{ matched: boolean }> {
    const result = await this.client.executeCommand({ sessionId, line: '/plan' })
    return { matched: result !== undefined }
  }

  pickDirectory(): Promise<{ path: string | null }> {
    return this.client.pickDirectory().then((path) => ({ path }))
  }

  // ---- 自定义 provider（llm-pi-ai） ----

  /** 读取用户添加的自定义 provider（来自 settings.describe 的 llm-pi-ai 区）。 */
  async listCustomProviders(): Promise<CustomProviderListItem[]> {
    const describe = await this.client.settingsDescribe()
    const ns = describe.namespaces.find((n) => n.ns === 'llm-pi-ai')
    const providers = (ns?.value?.providers ?? {}) as Record<string, Record<string, unknown>>
    // 活跃状态：provider 出现在 modelCatalog.routableProviders 即视为可用
    const catalog = await this.client.modelCatalog().catch(() => null)
    const activeIds = new Set(catalog?.routableProviders ?? [])
    return Object.entries(providers).map(([id, cfg]) => ({
      id,
      displayName: String(cfg.displayName ?? id),
      apiKeyEnv: typeof cfg.apiKeyEnv === 'string' ? cfg.apiKeyEnv : undefined,
      api: String(cfg.api ?? 'openai-completions'),
      baseURL: String(cfg.baseURL ?? ''),
      models: Array.isArray(cfg.models)
        ? cfg.models.map((m) => {
            const mm = m as Record<string, unknown>
            return {
              id: String(mm.id ?? ''),
              name: typeof mm.name === 'string' ? mm.name : undefined,
            }
          })
        : [],
      active: activeIds.has(id),
    }))
  }

  /** 保存（新增或更新）一个自定义 provider 到 dsh settings。 */
  async saveCustomProvider(config: CustomProviderConfig): Promise<unknown> {
    const apiKeyEnv = config.apiKeyEnv ?? envRefFor(config.id)
    const patch = {
      providers: {
        [config.id]: {
          displayName: config.displayName,
          apiKeyEnv,
          api: config.api,
          baseURL: config.baseURL,
          models: config.models.map((m) => ({
            id: m.id,
            ...(m.name ? { name: m.name } : {}),
          })),
        },
      },
    }
    return this.client.settingsUpdate({ ns: 'llm-pi-ai', patch })
  }

  /** 删除一个自定义 provider。 */
  async removeCustomProvider(id: string): Promise<unknown> {
    return this.client.settingsMutate({
      ns: 'llm-pi-ai',
      ops: [{ op: 'unset', path: ['providers', id] }],
    })
  }

  /** 写入自定义 provider 的 API Key（凭据库，引用式存储）。 */
  async setProviderApiKey(apiKeyEnv: string, key: string): Promise<void> {
    await this.client.credentialsSet({ ref: apiKeyEnv, value: key })
  }

  // ---- 事件流 ----

  onSessionEvent(cb: (evt: SessionStreamEvent) => void): () => void {
    this.eventListeners.push(cb)
    if (this.control === null) {
      const stream = this.client.openStream('session/control', {})
      this.control = stream
      stream.onItem = (value) => {
        for (const evt of normalizeControlFrame(value as Record<string, unknown>)) {
          dispatch(this.eventListeners, evt)
        }
      }
    }
    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== cb)
    }
  }

  close() {
    if (this.control) {
      this.control.onItem = null
      this.client.muxCancel(this.control)
      this.control = null
    }
    for (const stream of this.follows.values()) {
      stream.onItem = null
      this.client.muxCancel(stream)
    }
    this.follows.clear()
    this.eventListeners = []
    this.client.close()
  }
}

export type { DshEvent, MessageBlock }
