import { useState } from 'react'

import type { UserMenuItem } from '@ai-resume-screener/auth-client-web'
import { SKINS, SKIN_LABELS, getSkin, setSkin } from '@ai-resume-screener/design-tokens'

/** 皮肤切换项，挂进右上角 UserMenu。 */
export function useSkinMenuItems(): UserMenuItem[] {
  const [current, setCurrent] = useState(getSkin)
  return SKINS.map((s) => ({
    label: `皮肤：${SKIN_LABELS[s]}${s === current ? ' ✓' : ''}`,
    onClick: () => {
      setSkin(s)
      setCurrent(s)
    },
  }))
}
