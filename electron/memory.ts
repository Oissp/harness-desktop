/**
 * electron/memory.ts —— harness-memory 插件记忆的桌面端读写。
 *
 * 插件把记忆持久化到 `$DSH_HOME/storages/harness_memory.json`（storage-json 单元格式）。
 * 桌面端直接读写该文件展示/管理记忆。
 *
 * 竞态说明（已知限制）：运行中的 dsh 引擎在内存中持有记忆态并自行落盘该文件，
 * 桌面端的写入对运行中的引擎不可见，且引擎下次落盘会覆盖桌面端写入。
 * 因此桌面端增删的记忆只在「dsh 未运行 / 重启后」才可靠生效——UI 上可读，
 * 但不要承诺「即时生效」。彻底修复需走引擎 storageDomain RPC（当前 adapter 未暴露）。
 *
 * 这里至少做到：写前重读最新文件（拿到引擎最近一次落盘）+ 原子写（temp + rename），
 * 避免引擎读到半写文件造成 storage 单元解析失败。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryItem } from '../shared/types.js'

interface MemoryUnit {
  unit: { name: string; version: number }
  global: unknown
  tables: { memories: Record<string, MemoryItem> }
}

function memoryFile(dshHome: string): string {
  return join(dshHome, 'storages', 'harness_memory.json')
}

function readUnit(dshHome: string): MemoryUnit {
  const file = memoryFile(dshHome)
  if (!existsSync(file)) {
    return { unit: { name: 'harness_memory', version: 1 }, global: null, tables: { memories: {} } }
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as MemoryUnit
    if (!parsed.tables?.memories) parsed.tables = { memories: {} }
    return parsed
  } catch {
    return { unit: { name: 'harness_memory', version: 1 }, global: null, tables: { memories: {} } }
  }
}

/** 原子写入：先写临时文件再 rename，避免引擎读到半写文件导致 storage 单元损坏。 */
function writeUnit(dshHome: string, unit: MemoryUnit) {
  const file = memoryFile(dshHome)
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(unit, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

export function listMemories(dshHome: string): MemoryItem[] {
  const unit = readUnit(dshHome)
  return Object.values(unit.tables.memories).sort((a, b) => b.updatedAt - a.updatedAt)
}

export function addMemory(dshHome: string, text: string, tags: string[] = []): MemoryItem {
  const unit = readUnit(dshHome)
  const now = Date.now()
  const item: MemoryItem = { id: `mem-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, text, tags, createdAt: now, updatedAt: now }
  unit.tables.memories[item.id] = item
  writeUnit(dshHome, unit)
  return item
}

export function deleteMemory(dshHome: string, id: string): boolean {
  const unit = readUnit(dshHome)
  if (!(id in unit.tables.memories)) return false
  delete unit.tables.memories[id]
  writeUnit(dshHome, unit)
  return true
}

export function clearMemories(dshHome: string): void {
  const unit = readUnit(dshHome)
  unit.tables.memories = {}
  writeUnit(dshHome, unit)
}
