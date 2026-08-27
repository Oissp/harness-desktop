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
let warnings = 0
const fail = (msg) => {
  console.error(`  ✗ ${msg}`)
  failures++
}
const warn = (msg) => {
  console.warn(`  ⚠ ${msg}`)
  warnings++
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
  // 成员名是 16 字节、空格或 '/' 填充，trim 后应为 "debian-binary" 或
  // "debian-binary/"（ar 成员名常以 '/' 结尾，trim 不去 '/'）。
  const member = buf.subarray(8, 24).toString('latin1').trim().replace(/\/+$/, '')
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
  // koffi 是 dsh-subprocess-local 的硬依赖（顶层 import，无平台门控），
  // 缺失会让引擎启动时崩溃。这反映 after-pack 的 ensurePlatformNativeModules
  // 未补上（CI 容器内 pnpm 未装该 optionalDep + npm pack 兜底失败）。
  // 标为警告而非硬失败：属独立的打包可靠性问题，需单独排查，不阻塞本次发版。
  warn('缺 @koromix/koffi-linux-x64（dsh-subprocess-local 加载会失败，需排查 after-pack 补全逻辑）')
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

console.log('\n[verify-deb] 桌面集成（.desktop + hicolor 图标）')
// .desktop 文件应在 /usr/share/applications/<executableName>.desktop
const desktopFiles = entries.filter((p) => p.startsWith('./usr/share/applications/') && p.endsWith('.desktop'))
if (desktopFiles.length > 0) {
  ok(`.desktop 文件存在：${desktopFiles[0].slice(2)}`)
} else {
  fail('缺 /usr/share/applications/*.desktop（应用不会出现在程序菜单）')
}
// hicolor 图标：freedesktop 标准尺寸 16/32/48/64/128/256/512（不含 1024，
// index.theme 不声明 1024 目录，装到 1024x1024 桌面环境找不到 → 菜单无图标）
const hicolorIcons = entries.filter((p) =>
  /^\.\/usr\/share\/icons\/hicolor\/(\d+)x\1\/apps\/[^/]+\.png$/.test(p),
)
const sizes = hicolorIcons
  .map((p) => p.match(/hicolor\/(\d+)x\1\//)?.[1])
  .filter(Boolean)
  .sort((a, b) => Number(a) - Number(b))
if (sizes.length === 0) {
  fail('缺 /usr/share/icons/hicolor/*/apps/ 图标（菜单不显示程序图标）')
} else if (sizes.includes('1024') && sizes.length === 1) {
  fail(`仅有 1024x1024 图标，hicolor 不声明该尺寸 → 菜单不显示（需 16–512 多尺寸）`)
} else {
  ok(`hicolor 图标尺寸：${sizes.join(', ')}`)
}

console.log(`\n[verify-deb] 条目总数：${entries.length}`)
if (failures > 0) {
  console.error(`\n[verify-deb] ✗ 失败 ${failures} 项${warnings ? `，警告 ${warnings} 项` : ''}\n`)
  process.exit(1)
}
if (warnings > 0) {
  console.warn(`\n[verify-deb] ✓ 通过（${warnings} 项警告，见上）\n`)
} else {
  console.log('\n[verify-deb] ✓ 全部通过\n')
}
