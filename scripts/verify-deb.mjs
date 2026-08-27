/**
 * scripts/verify-deb.mjs —— 打包产物完整性校验（PR #304 实践）。
 *
 * electron-builder 的 deb 产物最易在 after-pack.mjs 的整体复制环节出错：
   依赖闭包缺失、原生模块平台不符、非目标平台 prebuild 泄入等。CI 里仅
   `dpkg-deb -I` 打印 control 不足以发现这些。本脚本做四件事：
 *   1. magic bytes：确认是合法的 ar 归档（deb 包格式）
 *   2. 关键运行时路径：@deepseek-ai/ 闭包、koffi 原生模块、主可执行文件
 *   3. 平台纯净性：不应出现非 linux-x64 的 prebuild（arm64/win32/darwin）
 *   4. 打印体积与包数摘要
 *
 * 用法：node scripts/verify-deb.mjs [out/xxx.deb]（缺省则取 out/*.deb 第一个）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

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

// 1. magic bytes：deb 是 ar 归档，以 "!<arch>\n" 开头，首个成员名 debian-binary
const head = readFileSync(deb, { encoding: 'ascii', end: 16 })
// ar 魔数占 8 字节；随后是 60 字节的 debian-binary 成员头，成员名在第 0~15 字节
const magic = head.slice(0, 8)
const memberName = head.slice(8, 16).trim()
if (magic === '!<arch>\n' && memberName === 'debian-binary') {
  ok('magic bytes：合法 deb（ar 归档 + debian-binary）')
} else {
  fail(`magic bytes 不符：magic=${JSON.stringify(magic)} member=${JSON.stringify(memberName)}`)
}

// 后续校验基于 dpkg-deb 内容清单
const listing = execFileSync('dpkg-deb', ['-c', deb], { encoding: 'utf8' })
// dpkg-deb -c 输出形如 "drwxr-xr-x 0/0      0 2026-..  ./path/"，取路径列
const entries = listing
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    // 路径是最后一个 ./... 字段，取从 './' 起的部分
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
const leaked = entries.filter((p) =>
  /\/node_modules\/[^/]+(@koromix\/koffi|@img\/sharp|@esbuild|@vscode\/ripgrep)?[^/]*-(linux-arm64|win32-x64|win32-ia32|darwin-x64|darwin-arm64|freebsd-)/.test(p) ||
  /\/node_modules\/@(koromix|img|esbuild)\/[^/]+-(linux-arm64|win32-|darwin-|freebsd-)/.test(p),
)
// 取泄露的包名（去重），仅报包根
const leakedPkgs = new Set(
  leaked
    .map((p) => {
      const m = p.match(/\/node_modules\/(@[^/]+\/[^/]+|[^/]+)/)
      return m ? m[1] : null
    })
    .filter(Boolean)
    .filter((n) => /-(linux-arm64|win32-|darwin-|freebsd-)/.test(n)),
)
if (leakedPkgs.size === 0) {
  ok('无非目标平台 prebuild 泄入')
} else {
  fail(`非目标平台 prebuild 泄入：${[...leakedPkgs].join(', ')}`)
}

console.log(`\n[verify-deb] 条目总数：${entries.length}`)
if (failures > 0) {
  console.error(`\n[verify-deb] ✗ 失败 ${failures} 项\n`)
  process.exit(1)
}
console.log('\n[verify-deb] ✓ 全部通过\n')
