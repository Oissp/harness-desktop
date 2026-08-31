import { defineConfig } from 'vitest/config'

const testFiles = (root: string) => [
  `${root}/**/*.test.ts`,
  `${root}/**/*.test.tsx`,
  `${root}/**/*.spec.ts`,
  `${root}/**/*.spec.tsx`,
]

export default defineConfig({
  test: {
    // 只运行本项目测试，避免把项目级 pnpm store 或 vendored 依赖当成测试根。
    include: [
      ...testFiles('src'),
      ...testFiles('adapter'),
      ...testFiles('electron'),
      ...testFiles('plugins/__tests__'),
    ],
    exclude: [
      '.pnpm-store/**',
      'node_modules/**',
      'dist/**',
      'dist-electron/**',
      'out/**',
      'vendor/**',
    ],
  },
})
