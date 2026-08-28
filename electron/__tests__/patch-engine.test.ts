/**
 * electron/__tests__/patch-engine.test.ts —— 幂等补丁框架单测。
 *
 * 借鉴 dsh_desktop 的补丁引擎测试思路：验证幂等性（重复 apply 不重复打）、
 * transform 返回 null 时不写、原子写正常工作。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyPatch, isPatched, applyAllPatches, type PatchSpec } from '../patch-engine'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'patch-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeSpec(id: string, transform: (c: string) => string | null): PatchSpec & { file: string } {
  const file = join(tmpDir, `target-${id}.js`)
  writeFileSync(file, 'const x = 1\n', 'utf8')
  return { id, file, description: `test patch ${id}`, transform }
}

describe('patch-engine', () => {
  describe('applyPatch 幂等性', () => {
    it('首次 apply 返回 applied 并修改文件', () => {
      const spec = makeSpec('p1', (c) => c.replace('const x = 1', 'const x = 2'))
      const result = applyPatch(spec)
      expect(result).toBe('applied')
      const content = readFileSync(spec.file, 'utf8')
      expect(content).toContain('const x = 2')
      expect(content).toContain('@harness-desktop-patch:p1')
    })

    it('第二次 apply 返回 skipped，文件不变', () => {
      const spec = makeSpec('p2', (c) => c.replace('const x = 1', 'const x = 2'))
      applyPatch(spec)
      const afterFirst = readFileSync(spec.file, 'utf8')
      const result = applyPatch(spec)
      expect(result).toBe('skipped')
      expect(readFileSync(spec.file, 'utf8')).toBe(afterFirst)
    })

    it('transform 返回 null 时返回 noop，文件不变', () => {
      const spec = makeSpec('p3', () => null)
      const before = readFileSync(spec.file, 'utf8')
      const result = applyPatch(spec)
      expect(result).toBe('noop')
      expect(readFileSync(spec.file, 'utf8')).toBe(before)
    })
  })

  describe('isPatched', () => {
    it('未打补丁返回 false', () => {
      const spec = makeSpec('p4', (c) => c + '// patched')
      expect(isPatched(spec)).toBe(false)
    })

    it('打补丁后返回 true', () => {
      const spec = makeSpec('p5', (c) => c + '// patched')
      applyPatch(spec)
      expect(isPatched(spec)).toBe(true)
    })
  })

  describe('applyAllPatches', () => {
    it('批量应用返回每个补丁的结果', () => {
      const specs = [
        makeSpec('a1', (c) => c.replace('1', '2')),
        makeSpec('a2', () => null),
        makeSpec('a3', (c) => c.replace('1', '3')),
      ]
      const results = applyAllPatches(specs)
      expect(results).toHaveLength(3)
      expect(results[0]).toEqual({ id: 'a1', result: 'applied' })
      expect(results[1]).toEqual({ id: 'a2', result: 'noop' })
      expect(results[2]).toEqual({ id: 'a3', result: 'applied' })
    })

    it('重复批量应用全 skipped', () => {
      const specs = [
        makeSpec('b1', (c) => c.replace('1', '2')),
        makeSpec('b2', (c) => c.replace('1', '3')),
      ]
      applyAllPatches(specs)
      const results = applyAllPatches(specs)
      expect(results.every((r) => r.result === 'skipped')).toBe(true)
    })
  })

  describe('目标文件不存在', () => {
    it('目标文件不存在返回 noop，不抛异常', () => {
      const spec: PatchSpec = {
        id: 'missing',
        file: join(tmpDir, 'nonexistent.js'),
        description: 'no file',
        transform: (c) => c,
      }
      expect(applyPatch(spec)).toBe('noop')
      expect(existsSync(spec.file)).toBe(false)
    })
  })
})
