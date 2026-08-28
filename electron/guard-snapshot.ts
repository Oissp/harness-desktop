/**
 * electron/guard-snapshot.ts —— 配置快照 / 回滚（守护瀑布的 guard 层）。
 *
 * 借鉴 dsh_desktop 的 guard-snapshot / guard-restore：boot 前对关键配置文件
 * 做快照，引擎稳定运行后（markGood）提升为"最后良好"快照；boot 失败时
 * 回滚到"最后良好"，避免坏配置导致反复崩溃。
 *
 * 快照存储在 `<userData>/guard-snapshots/`：
 *  - `pending/`  —— boot 前拍的快照（尚未确认良好）
 *  - `last-good/` —— 引擎稳定后提升的快照（回滚源）
 *
 * 每个快照是 GUARD_FILES 的扁平副本（文件名 = 原文件 basename）。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/** 受守护的关键配置文件（相对 dshHome 的路径）。 */
const GUARD_FILES = [
  'profiles/web/package.json',
  'profiles/web/cordis.patch.yml',
  '.credentials.yaml',
] as const

/** 快照根目录。 */
function snapshotRoot(): string {
  return join(app.getPath('userData'), 'guard-snapshots')
}

/** pending / last-good 子目录。 */
function snapshotDir(kind: 'pending' | 'last-good'): string {
  const dir = join(snapshotRoot(), kind)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * boot 前拍快照：把 GUARD_FILES 中存在的文件复制到 pending/。
 * 不存在则跳过（首次启动时 profile 尚未创建）。
 */
export function takeBootSnapshot(dshHome: string): void {
  const dir = snapshotDir('pending')
  // 清空 pending
  for (const f of readdirSync(dir)) {
    rmSync(join(dir, f), { force: true })
  }
  for (const rel of GUARD_FILES) {
    const src = join(dshHome, rel)
    if (existsSync(src)) {
      const basename = rel.split('/').pop()!
      cpSync(src, join(dir, basename))
    }
  }
}

/**
 * 引擎稳定运行后调用（对应参考项目的 45s markGood）：
 * 把 pending 快照提升为 last-good。
 */
export function promoteToLastGood(): void {
  const pending = snapshotDir('pending')
  const lastGood = snapshotDir('last-good')
  // 清空 last-good
  for (const f of readdirSync(lastGood)) {
    rmSync(join(lastGood, f), { force: true })
  }
  // 复制 pending → last-good
  if (existsSync(pending)) {
    for (const f of readdirSync(pending)) {
      cpSync(join(pending, f), join(lastGood, f))
    }
  }
}

/**
 * boot 失败时回滚：把 last-good 快照恢复回 dshHome 原位。
 * 只恢复存在的快照文件（首次启动无 last-good 时为空操作）。
 * @returns 实际恢复的文件数（0 = 无可恢复快照）
 */
export function restoreFromLastGood(dshHome: string): number {
  const lastGood = snapshotDir('last-good')
  const files = existsSync(lastGood) ? readdirSync(lastGood) : []
  if (files.length === 0) return 0

  // basename → 原始相对路径的映射
  const basenameToRel = new Map(GUARD_FILES.map((rel) => [rel.split('/').pop()!, rel]))

  let restored = 0
  for (const f of files) {
    const rel = basenameToRel.get(f)
    if (!rel) continue // 未知文件，跳过
    const dest = join(dshHome, rel)
    mkdirSync(join(dest, '..'), { recursive: true })
    try {
      cpSync(join(lastGood, f), dest)
      restored++
    } catch {
      // 恢复失败不阻断（尽力而为）
    }
  }
  return restored
}

/**
 * 坏配置自愈：把损坏的配置文件隔离成 `.broken-<ts>` 后从模板重建。
 * 借鉴 dsh_desktop 的 profile-bundle-heal.js：坏 package.json 备份再重建，
 * 而不是让整个 boot 崩溃。
 *
 * @param filePath 配置文件路径
 * @param rebuildFn 重建函数：返回重建后的文件内容（失败则返回 null 不写）
 * @returns true = 已隔离并重建；false = 文件正常或重建失败
 */
export function healCorruptConfig(
  filePath: string,
  rebuildFn: () => string | null,
): boolean {
  if (!existsSync(filePath)) return false
  try {
    // 尝试解析（JSON / 空文件检测）
    const content = readFileSync(filePath, 'utf8')
    if (content.trim().length === 0) throw new Error('空文件')
    if (filePath.endsWith('.json')) {
      JSON.parse(content) // 解析失败会抛
    }
    return false // 文件正常
  } catch {
    // 文件损坏 → 隔离
    const broken = `${filePath}.broken-${Date.now()}`
    try {
      cpSync(filePath, broken)
    } catch {
      // 隔离失败不阻断
    }
    const rebuilt = rebuildFn()
    if (rebuilt !== null) {
      try {
        writeFileSync(filePath, rebuilt, 'utf8')
        return true
      } catch {
        // 写入失败
      }
    }
    return false
  }
}
