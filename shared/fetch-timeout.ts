/**
 * shared/fetch-timeout.ts —— 带超时的 fetch 封装。
 *
 * 主进程与 adapter 传输层各自手搓过 AbortController+setTimeout+clearTimeout，
 * 且已出现行为分叉（是否区分 abort 与其他网络错误）。收拢到这里，统一实现。
 */

/** 带超时的 fetch；超时或请求异常都会 reject，调用方用 isAbortError 区分原因。 */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** 判断 fetchWithTimeout 的失败是否为超时触发的 abort（而非网络/DNS 等其他错误）。 */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}
