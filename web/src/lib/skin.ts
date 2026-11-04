import { useState } from 'react'

import type { UserMenuItem } from '@ai-resume-screener/auth-client-web'
import { SKINS, getSkin, setSkin } from '@ai-resume-screener/design-tokens'

import { useI18n } from '@/i18n'

/** 皮肤切换项，挂进左下角 UserMenu。 */
export function useSkinMenuItems(): UserMenuItem[] {
  const { t } = useI18n()
  const [current, setCurrent] = useState(getSkin)
  return SKINS.map((s) => ({
    label: `${t('menu.skin', { name: t(`skin.${s}`) })}${s === current ? ' ✓' : ''}`,
    onClick: () => {
      setSkin(s)
      setCurrent(s)
    },
  }))
}
