/**
 * electron/__tests__/migrate-userdata.test.ts —— userData 迁移单测。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrateUserData } from '../migrate-userdata'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'migrate-test-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeFile(path: string, content: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

describe('migrateUserData', () => {
  it('从单个旧目录迁移根层文件和 dsh-home', () => {
    const oldDir = join(root, 'harness-desktop')
    const newDir = join(root, 'dsh-desktop')

    writeFile(join(oldDir, 'app-settings.json'), '{"onboarded":true}')
    writeFile(join(oldDir, '.updaterId'), 'abc123')
    writeFile(join(oldDir, 'dsh-home', 'settings.yaml'), 'provider: deepseek')
    writeFile(join(oldDir, 'dsh-home', 'sessions', 'proj-a', 'log.jsonl'), 'line1')

    const result = migrateUserData(newDir, [oldDir])
    expect(result).toBe(true)

    expect(readFileSync(join(newDir, 'app-settings.json'), 'utf8')).toBe('{"onboarded":true}')
    expect(readFileSync(join(newDir, '.updaterId'), 'utf8')).toBe('abc123')
    expect(readFileSync(join(newDir, 'dsh-home', 'settings.yaml'), 'utf8')).toBe('provider: deepseek')
    expect(readFileSync(join(newDir, 'dsh-home', 'sessions', 'proj-a', 'log.jsonl'), 'utf8')).toBe('line1')
    expect(existsSync(join(newDir, '.migrated-from-harness-desktop'))).toBe(true)
    // 旧目录已清理
    expect(existsSync(oldDir)).toBe(false)
  })

  it('多个旧目录按优先级合并', () => {
    const old1 = join(root, 'harness-desktop')
    const old2 = join(root, 'DSH Desktop')
    const newDir = join(root, 'dsh-desktop')

    // old1（高优先级）有 app-settings 但没 .updaterId
    writeFile(join(old1, 'app-settings.json'), '{"from":"old1"}')
    writeFile(join(old1, 'dsh-home', 'sessions', 'proj-a', 'a.jsonl'), 'from-old1')

    // old2（低优先级）有 .updaterId 和额外 session
    writeFile(join(old2, '.updaterId'), 'from-old2')
    writeFile(join(old2, 'app-settings.json'), '{"from":"old2"}')
    writeFile(join(old2, 'dsh-home', 'sessions', 'proj-b', 'b.jsonl'), 'from-old2')
    writeFile(join(old2, 'dsh-home', 'sessions', 'proj-a', 'a.jsonl'), 'from-old2-stale')

    const result = migrateUserData(newDir, [old1, old2])
    expect(result).toBe(true)

    // app-settings 取 old1（优先级高）
    expect(readFileSync(join(newDir, 'app-settings.json'), 'utf8')).toBe('{"from":"old1"}')
    // .updaterId 取 old2（old1 没有，退而求其次）
    expect(readFileSync(join(newDir, '.updaterId'), 'utf8')).toBe('from-old2')
    // sessions 合并：proj-a 来自 old1（先到先得），proj-b 来自 old2
    expect(readFileSync(join(newDir, 'dsh-home', 'sessions', 'proj-a', 'a.jsonl'), 'utf8')).toBe('from-old1')
    expect(readFileSync(join(newDir, 'dsh-home', 'sessions', 'proj-b', 'b.jsonl'), 'utf8')).toBe('from-old2')
  })

  it('已有 .migrated 标记时跳过', () => {
    const oldDir = join(root, 'harness-desktop')
    const newDir = join(root, 'dsh-desktop')

    writeFile(join(oldDir, 'app-settings.json'), '{"should":"not-migrate"}')
    mkdirSync(newDir, { recursive: true })
    writeFileSync(join(newDir, '.migrated-from-harness-desktop'), 'done', 'utf8')

    const result = migrateUserData(newDir, [oldDir])
    expect(result).toBe(false)
    // 旧目录未被删除
    expect(existsSync(oldDir)).toBe(true)
    // 新目录没有 app-settings
    expect(existsSync(join(newDir, 'app-settings.json'))).toBe(false)
  })

  it('旧目录都不存在时返回 false', () => {
    const newDir = join(root, 'dsh-desktop')
    const result = migrateUserData(newDir, [
      join(root, 'nonexistent-1'),
      join(root, 'nonexistent-2'),
    ])
    expect(result).toBe(false)
  })

  it('guard-snapshots 整目录复制', () => {
    const oldDir = join(root, 'harness-desktop')
    const newDir = join(root, 'dsh-desktop')

    writeFile(join(oldDir, 'guard-snapshots', 'last-good', 'package.json'), '{}')
    writeFile(join(oldDir, 'guard-snapshots', 'pending', 'package.json'), '{}')

    migrateUserData(newDir, [oldDir])

    expect(existsSync(join(newDir, 'guard-snapshots', 'last-good', 'package.json'))).toBe(true)
    expect(existsSync(join(newDir, 'guard-snapshots', 'pending', 'package.json'))).toBe(true)
  })

  it('新目录已有文件时不覆盖', () => {
    const oldDir = join(root, 'harness-desktop')
    const newDir = join(root, 'dsh-desktop')

    writeFile(join(oldDir, 'app-settings.json'), '{"from":"old"}')
    writeFile(join(newDir, 'app-settings.json'), '{"from":"existing"}')

    migrateUserData(newDir, [oldDir])

    expect(readFileSync(join(newDir, 'app-settings.json'), 'utf8')).toBe('{"from":"existing"}')
  })

  it('dsh-home 根层文件迁移（settings.yaml / .credentials.yaml）', () => {
    const oldDir = join(root, 'harness-desktop')
    const newDir = join(root, 'dsh-desktop')

    writeFile(join(oldDir, 'dsh-home', 'settings.yaml'), 'key: val')
    writeFile(join(oldDir, 'dsh-home', '.credentials.yaml'), 'secret: abc')

    migrateUserData(newDir, [oldDir])

    expect(readFileSync(join(newDir, 'dsh-home', 'settings.yaml'), 'utf8')).toBe('key: val')
    expect(readFileSync(join(newDir, 'dsh-home', '.credentials.yaml'), 'utf8')).toBe('secret: abc')
  })
})
