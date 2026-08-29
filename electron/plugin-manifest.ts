/**
 * electron/plugin-manifest.ts —— 声明式伴随插件清单（单一来源）。
 *
 * 借鉴 dsh_desktop 的 COMPANION_PLUGINS 数组（dsh-desktop/scripts/lib/companion-plugins.js）：
 * 把"装哪些插件"从硬编码数组升级为声明式清单，每条目含元数据，
 * 新增/禁用插件只改清单不改安装逻辑。
 *
 * 清单是插件管理的唯一事实源——profile-setup.ts 读取它来决定安装哪些插件。
 * 每个条目：
 *  - id：插件名（与 plugins/<id>/ 目录名一致，也是 dsh bundle 名）
 *  - enabled：是否启用（默认 true；可按条件禁用，如 harness-pet 默认关）
 *  - fatal：安装失败是否致命（false = 静默降级，true = 阻断启动）
 */

/** 一个伴随插件的清单条目。 */
export interface CompanionPluginEntry {
  /** 插件 id（= 目录名 = dsh bundle 名）。 */
  id: string
  /** 是否启用（默认 true）。 */
  enabled?: boolean
  /** 安装失败是否致命（默认 false = 静默降级）。 */
  fatal?: boolean
  /** 人类可读说明（诊断用）。 */
  description?: string
}

/**
 * 伴随插件清单（单一来源）。
 *
 * 新增插件只需在此数组加一条目 + 在 plugins/<id>/ 放插件源码。
 * 禁用插件只需设 enabled: false（不卸载已有安装，仅不再同步）。
 */
export const COMPANION_PLUGINS: CompanionPluginEntry[] = [
  {
    id: 'harness-memory',
    enabled: true,
    fatal: false,
    description: '记忆自动沉淀（偏好/项目约定/成功做法）',
  },
  // 新增伴随插件在此添加，例如：
  // { id: 'harness-pet', enabled: false, description: '桌面宠物（默认关）' },
]

/**
 * 获取当前应安装的插件列表（已过滤 enabled: false 的）。
 */
export function activeCompanionPlugins(): CompanionPluginEntry[] {
  return COMPANION_PLUGINS.filter((p) => p.enabled !== false)
}
