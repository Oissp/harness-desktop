/**
 * scripts/verify-deb.mjs —— 打包产物完整性校验（PR #304 实践）。
 *
 * electron-builder 的 deb 产物最易在 after-pack.mjs 的整体复制环节出错：
   依赖闭包缺失、原生模块平台不符、非目标平台 prebuild 泄入等。CI 里仅
   `dpkg-deb -I` 打印 control 不足以发现这些。本脚本做四件事：
 *   1. magic bytes：确认是合法的 ar 归档（deb 包格式）
 *   2. 关键运行时路径：@deepseek-ai/ 闭包、koffi 原生模块、主可执行文件
 *   3. 平台纯净性：不应出现非 linux-x64 的 prebuild（arm64/win32/darwin）
 *   4. 打印体积与条目摘要
 *
 * 用法：node scripts/verify-deb.mjs [out/xxx.deb]（缺省则取 out/*.deb 第一个）
 */
import { openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const deb = process.argv[2]
  ?? readdirSync('out').map((f) => `out/${f}`).filter((f) => f.endsWith('.deb')).sort()[0]

if (!deb) {
  console.error('[verify-deb] 未找到 .deb 产物')
  process.exit(1)
}

let failures = 0
const fail = (msg) => {
  console.error(`  ✗ ${msg}`)
  failures++
}
const ok = (msg) => console.log(`  ✓ ${msg}`)

console.log(`\n[verify-deb] 校验 ${deb}（${(statSync(deb).size / 1024 / 1024).toFixed(1)} MB）`)

// 1. magic bytes：deb 是 ar 归档，以 "!<arch>\n"（8 字节）开头，紧随的成员名为
//    "debian-binary"（ar 头部成员名字段为 16 字节，偏移 8..24）。只读前 68 字节
//    足够覆盖 magic + 首个 ar 头，避免把 100MB+ 的 deb 整体读进内存。
const fd = openSync(deb, 'r')
const buf = Buffer.alloc(68)
const bytesRead = readSync(fd, buf, 0, 68, 0)
closeSync(fd)
if (bytesRead >= 24) {
  const magic = buf.subarray(0, 8).toString('latin1')
  // 成员名是 16 字节、空格填充，trim 后应为 "debian-binary"
  const member = buf.subarray(8, 24).toString('latin1').trim()
  if (magic === '!<arch>\n' && member === 'debian-binary') {
    ok('magic bytes：合法 deb（ar 归档 + debian-binary）')
  } else {
    fail(`magic bytes 不符：magic=${JSON.stringify(magic)} member=${JSON.stringify(member)}`)
  }
} else {
  fail(`文件过短，无法读取 ar 头（${bytesRead} 字节）`)
}

// 后续校验基于 dpkg-deb 内容清单。大 deb 的清单可能数 MB，execFileSync 默认
// maxBuffer=1MB 会 ENOBUFS，这里放到 64MB。
const res = spawnSync('dpkg-deb', ['-c', deb], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
if (res.status !== 0) {
  fail(`dpkg-deb -c 失败（status=${res.status}）：${res.stderr?.trim() ?? ''}`)
  console.error(`\n[verify-deb] ✗ 无法读取内容清单，终止\n`)
  process.exit(1)
}
// dpkg-deb -c 输出形如 "drwxr-xr-x 0/0  0 2026-..  ./path/"，取从 './' 起的路径
const entries = res.stdout
  .split('\n')
  .map((line) => {
    const m = line.match(/(\.\/\S.*)$/)
    return m ? m[1] : ''
  })
  .filter(Boolean)

console.log('\n[verify-deb] 关键运行时路径')
const has = (pred) => entries.some(pred)
if (has((p) => p.includes('/node_modules/@deepseek-ai/'))) {
  ok('@deepseek-ai/ 依赖闭包存在')
} else {
  fail('缺 @deepseek-ai/ 依赖闭包（dsh 引擎将无法启动）')
}
if (has((p) => p.includes('/node_modules/@koromix/koffi-linux-x64/'))) {
  ok('koffi 原生模块（linux-x64）存在')
} else {
  fail('缺 @koromix/koffi-linux-x64（原生模块加载会失败）')
}
// 主可执行文件：opt/<productName>/ 下无扩展名的可执行
if (has((p) => /^\.\/opt\/[^/]+\/[^/]+$/.test(p))) {
  ok('主可执行文件存在')
} else {
  fail('未找到主可执行文件')
}

console.log('\n[verify-deb] 平台纯净性（不应有非 linux-x64 的 prebuild）')
// 收集所有 node_modules 下的包名（顶层或 @scope/name），去重
const pkgs = new Set()
for (const p of entries) {
  const m = p.match(/\/node_modules\/(@[^/]+\/[^/]+|[^/]+)/)
  if (m) pkgs.add(m[1])
}
// 平台 prebuild 包名形如 <pkg>-<platform>-<arch>；目标是 linux-x64，
// 其余 platform/arch 组合都是非目标 prebuild，不该进 x64 产物
const NON_TARGET = /-(linux|win32|darwin|freebsd)-(arm64|ia32|armv7l|x64)$/
const leaked = [...pkgs].filter((n) => NON_TARGET.test(n) && !n.endsWith('-linux-x64'))
if (leaked.length === 0) {
  ok('无非目标平台 prebuild 泄入')
} else {
  fail(`非目标平台 prebuild 泄入：${leaked.join(', ')}`)
}

console.log(`\n[verify-deb] 条目总数：${entries.length}`)
if (failures > 0) {
  console.error(`\n[verify-deb] ✗ 失败 ${failures} 项\n`)
  process.exit(1)
}
console.log('\n[verify-deb] ✓ 全部通过\n')
