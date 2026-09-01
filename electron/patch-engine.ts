/**
 * electron/patch-engine.ts —— 幂等文本手术补丁框架。
 *
 * 借鉴 dsh_desktop 的 runtime-patch-registry + patch-runner：
 * 对 dsh 内核文件做"文本手术"修复上游缺陷时，用幂等标记保证
 * 重复执行（boot 时 / 每次启动）不会重复打补丁。
 *
 * 设计要点：
 *  - 每个 PatchSpec 有唯一 id（幂等标记，写入被补丁文件的注释行）
 *  - apply 时先检测标记：已打则跳过，未打则执行 transform 并写入标记
 *  - transform 是纯函数：(原文件内容) → 补丁后内容 | null（null=无需补丁）
 *  - 原子写：临时文件 + rename，避免半写损坏
 *
 * 当前为通用框架，暂不挂载具体补丁 spec（待上游出现需修补的缺陷时添加）。
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'

/** 幂等标记前缀（写入被补丁文件，检测已打补丁）。 */
const PATCH_MARKER_PREFIX = '// @dsh-desktop-patch:'

/** 一个补丁规格。 */
export interface PatchSpec {
  /** 唯一 id（用于幂等标记）。 */
  id: string
  /** 目标文件路径（绝对路径）。 */
  file: string
  /** 补丁说明（诊断用）。 */
  description: string
  /**
   * 文本变换函数：接收原文件内容，返回补丁后内容。
   * 返回 null 表示无需补丁（文件已含期望内容或条件不满足）。
   */
  transform: (content: string) => string | null
}

/**
 * 检测某个补丁是否已打（幂等检查）。
 * 通过在被补丁文件中查找幂等标记行实现。
 */
export function isPatched(spec: PatchSpec): boolean {
  if (!existsSync(spec.file)) return false
  const marker = `${PATCH_MARKER_PREFIX}${spec.id}`
  return readFileSync(spec.file, 'utf8').includes(marker)
}

/**
 * 应用单个补丁（幂等）。
 * @returns 'applied' = 本次打上; 'skipped' = 已打过跳过; 'noop' = transform 返回 null
 */
export function applyPatch(spec: PatchSpec): 'applied' | 'skipped' | 'noop' {
  // 幂等检查：已打过则跳过
  if (isPatched(spec)) return 'skipped'

  if (!existsSync(spec.file)) return 'noop'
  const original = readFileSync(spec.file, 'utf8')

  const patched = spec.transform(original)
  if (patched === null) return 'noop'

  // 在补丁后内容末尾追加幂等标记（确保下次启动检测到已打）
  const marker = `${PATCH_MARKER_PREFIX}${spec.id}\n`
  const withMarker = patched.endsWith('\n') ? patched + marker : patched + '\n' + marker

  // 原子写：先写临时文件再 rename，避免半写损坏目标文件
  const tmp = `${spec.file}.patching-${Date.now()}`
  try {
    writeFileSync(tmp, withMarker, 'utf8')
    renameSync(tmp, spec.file)
  } catch {
    // 写失败不阻断（与现有插件安装的非致命策略一致）
    return 'noop'
  }
  return 'applied'
}

/**
 * 批量应用补丁（boot 时调用）。
 * @returns 每个补丁的执行结果汇总
 */
export function applyAllPatches(specs: PatchSpec[]): {
  id: string
  result: 'applied' | 'skipped' | 'noop'
}[] {
  return specs.map((spec) => ({ id: spec.id, result: applyPatch(spec) }))
}

/**
 * 移除单个补丁的幂等标记（用于补丁 spec 变更后重新打）。
 * 注意：只移除标记，不回滚文件内容（文本手术不可逆，回滚靠 guard-snapshot）。
 */
export function clearPatchMarker(spec: PatchSpec): void {
  if (!existsSync(spec.file)) return
  const marker = `${PATCH_MARKER_PREFIX}${spec.id}`
  const content = readFileSync(spec.file, 'utf8')
  if (!content.includes(marker)) return
  writeFileSync(
    spec.file,
    content.replace(new RegExp(`\\n?${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`, 'g'), '\n'),
    'utf8',
  )
}
