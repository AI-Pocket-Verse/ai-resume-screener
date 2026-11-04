/**
 * 皮肤切换运行时。
 *
 * 皮肤是【设备偏好】(localStorage),不跟用户账号走 —— 换台机器回到默认皮肤 A。
 */

export const SKINS = ['a', 'b', 'c'] as const
export type Skin = (typeof SKINS)[number]

export const DEFAULT_SKIN: Skin = 'a'

/** 人类可读的皮肤名,给切换菜单用。 */
export const SKIN_LABELS: Record<Skin, string> = {
  a: '折中',
  b: '中性',
  c: '飞书蓝',
}

/**
 * 皮肤的存储 key。**必须与 web/index.html 的防闪内联脚本保持一致** ——
 * 不一致会先按默认皮肤渲染再跳到用户选的那套(闪一下)。
 */
export const SKIN_STORAGE_KEY = 'ai-resume-screener.skin'

function isSkin(v: unknown): v is Skin {
  return typeof v === 'string' && (SKINS as readonly string[]).includes(v)
}

/** 读当前皮肤。SSR / 非浏览器环境回落到默认皮肤。 */
export function getSkin(): Skin {
  if (typeof document === 'undefined') return DEFAULT_SKIN
  const attr = document.documentElement.dataset.skin
  if (isSkin(attr)) return attr
  try {
    const stored = localStorage.getItem(SKIN_STORAGE_KEY)
    if (isSkin(stored)) return stored
  } catch {
    // localStorage 可能被隐私模式/企业策略禁用 —— 静默回落,不影响渲染
  }
  return DEFAULT_SKIN
}

/** 切换皮肤:写 <html data-skin> + 持久化。非法值忽略。 */
export function setSkin(skin: Skin): void {
  if (!isSkin(skin) || typeof document === 'undefined') return
  document.documentElement.dataset.skin = skin
  try {
    localStorage.setItem(SKIN_STORAGE_KEY, skin)
  } catch {
    // 同上:存不进去也要让本次切换生效
  }
}

/**
 * 首屏应用已存皮肤。正常情况下由 index.html 的内联脚本在 CSS 加载前完成(防闪烁),
 * 这个函数是给「拿不到 index.html 的宿主环境」用的兜底。
 */
export function applyStoredSkin(): void {
  setSkin(getSkin())
}
