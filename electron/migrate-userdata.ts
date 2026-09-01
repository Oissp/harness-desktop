/**
 * electron/migrate-userdata.ts —— userData 路径一次性迁移。
 *
 * 背景：package.json name 从 harness-desktop 改为 dsh-desktop 后，用
 * app.setName('harness-desktop') 锁住了 userData 路径以保护已有数据。
 * 本模块把旧路径下的用户数据搬到 Electron 自然派生的新路径
 * （~/.config/dsh-desktop/），之后即可去掉 setName 锁定。
 *
 * 必须在 app.whenReady() 之后、任何 app.getPath('userData') 消费者
 * （SettingsStore / DshManager / CredentialStore）之前调用。
 *
 * 迁移策略：
 *  - 只搬应用自有数据（dsh-home/、app-settings.json、safe-credentials.json、
 *    guard-snapshots/、.updaterId）。Chromium 缓存由 Electron 自动重建，不搬。
 *  - 多个旧目录可能共存，按优先级合并：harness-desktop（最活跃）>
 *    DSH Desktop/harness-desktop（较旧嵌套残留）> DSH Desktop（最旧根层）。
 *  - dsh-home 内的子目录（sessions/、storages/、profiles/）按目录 merge：
 *    同名条目取 mtime 最新的；不同名的都保留。
 *  - 根层文件（app-settings.json 等）取第一个存在的（优先级最高的旧目录）。
 *  - 写入 .migrated 标记防止重复执行。
 *  - 迁移完成后删除旧目录（Chromium 缓存 + 已搬走的数据，不再需要）。
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const MARKER = '.migrated-from-harness-desktop'

/** 需要迁移的应用自有根层文件。 */
const ROOT_FILES = ['app-settings.json', 'safe-credentials.json', '.updaterId'] as const

/** dsh-home 内需要按目录 merge 的子目录。 */
const DSH_HOME_MERGE_DIRS = ['sessions', 'storages', 'profiles'] as const

/** dsh-home 内的根层文件（直接取优先级最高的）。 */
const DSH_HOME_ROOT_FILES = ['settings.yaml', '.credentials.yaml'] as const

/**
 * 执行一次性迁移。
 *
 * @param newDir  新 userData 路径（app.getPath('userData') 在去掉 setName 后的值）
 * @param oldDirs 旧 userData 候选目录（优先级从高到低）
 * @returns true = 执行了迁移；false = 无需迁移（已迁移过或无旧目录）
 */
export function migrateUserData(newDir: string, oldDirs: string[]): boolean {
  if (existsSync(join(newDir, MARKER))) return false

  const existingOld = oldDirs.filter((d) => existsSync(d))
  if (existingOld.length === 0) return false

  mkdirSync(newDir, { recursive: true })

  // 1. 根层文件：取优先级最高的旧目录里存在的那份
  for (const file of ROOT_FILES) {
    if (existsSync(join(newDir, file))) continue
    for (const old of existingOld) {
      const src = join(old, file)
      if (existsSync(src)) {
        cpSync(src, join(newDir, file))
        break
      }
    }
  }

  // 2. guard-snapshots/：整目录复制（取优先级最高的有内容的）
  const gsTarget = join(newDir, 'guard-snapshots')
  if (!existsSync(gsTarget)) {
    for (const old of existingOld) {
      const src = join(old, 'guard-snapshots')
      if (existsSync(src) && readdirSync(src).length > 0) {
        cpSync(src, gsTarget, { recursive: true })
        break
      }
    }
  }

  // 3. dsh-home/：按子目录 merge
  const newHome = join(newDir, 'dsh-home')
  mkdirSync(newHome, { recursive: true })

  // 3a. 根层文件
  for (const file of DSH_HOME_ROOT_FILES) {
    if (existsSync(join(newHome, file))) continue
    for (const old of existingOld) {
      const src = join(old, 'dsh-home', file)
      if (existsSync(src)) {
        cpSync(src, join(newHome, file))
        break
      }
    }
  }

  // 3b. 子目录 merge（sessions/、storages/、profiles/）
  for (const sub of DSH_HOME_MERGE_DIRS) {
    const targetSub = join(newHome, sub)
    mkdirSync(targetSub, { recursive: true })

    for (const old of existingOld) {
      const srcSub = join(old, 'dsh-home', sub)
      if (!existsSync(srcSub)) continue

      const entries = readdirSync(srcSub)
      for (const entry of entries) {
        const srcEntry = join(srcSub, entry)
        const dstEntry = join(targetSub, entry)

        if (!existsSync(dstEntry)) {
          // 目标不存在 → 直接复制
          cpSync(srcEntry, dstEntry, { recursive: true })
        } else {
          // 目标已存在 → 取 mtime 更新的
          try {
            const srcMtime = newestMtime(srcEntry)
            const dstMtime = newestMtime(dstEntry)
            if (srcMtime > dstMtime) {
              rmSync(dstEntry, { recursive: true, force: true })
              cpSync(srcEntry, dstEntry, { recursive: true })
            }
          } catch {
            // stat 失败不阻塞，保留已有的
          }
        }
      }
    }
  }

  // 4. 写标记
  writeFileSync(join(newDir, MARKER), `migrated at ${new Date().toISOString()}\n`, 'utf8')

  // 5. 清理旧目录
  for (const old of existingOld) {
    try {
      rmSync(old, { recursive: true, force: true })
    } catch {
      // 删除失败不阻塞（锁、权限等），下次启动也不会重复迁移（有标记）
    }
  }

  return true
}

/** 获取文件或目录树中最新的 mtime（ms）。目录递归取最大值。 */
function newestMtime(path: string): number {
  const stat = statSync(path)
  if (!stat.isDirectory()) return stat.mtimeMs

  let max = stat.mtimeMs
  try {
    for (const child of readdirSync(path)) {
      try {
        const childMtime = newestMtime(join(path, child))
        if (childMtime > max) max = childMtime
      } catch {
        // 跳过不可读子项
      }
    }
  } catch {
    // readdirSync 失败
  }
  return max
}
