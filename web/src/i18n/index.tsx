import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import type { UserMenuItem } from '@ai-resume-screener/auth-client-web'

import {
  format,
  readLangPref,
  resolveLang,
  setCurrentLang,
  writeLangPref,
  type Lang,
  type LangPref,
} from './lang'
import { MESSAGES, type MessageKey } from './messages'

export type { Lang, LangPref } from './lang'
export type { MessageKey } from './messages'

export type TFunction = (key: MessageKey, vars?: Record<string, string | number>) => string

interface I18nValue {
  /** 当前生效的语言 */
  lang: Lang
  /** 用户偏好(含「跟随系统」) */
  pref: LangPref
  setPref: (pref: LangPref) => void
  t: TFunction
}

const I18nContext = createContext<I18nValue | null>(null)

/** 取某种语言的翻译函数。组件外(如 ErrorBoundary 的 class 组件)也能用。 */
export function translator(lang: Lang): TFunction {
  return (key, vars) => format(MESSAGES[lang][key], vars)
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<LangPref>(readLangPref)
  // 跟随系统时,系统语言变了要跟着变(languagechange 事件)。
  const [sysTick, setSysTick] = useState(0)
  useEffect(() => {
    const onChange = () => setSysTick((n) => n + 1)
    window.addEventListener('languagechange', onChange)
    return () => window.removeEventListener('languagechange', onChange)
  }, [])

  // sysTick 只用来触发重算
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const lang = useMemo(() => resolveLang(pref), [pref, sysTick])
  // 渲染期间就同步给非组件代码(api.ts 的 X-Lang 头),避免首个请求带错语言。
  setCurrentLang(lang)

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
    document.title = MESSAGES[lang]['app.title']
  }, [lang])

  const setPref = useCallback((p: LangPref) => {
    writeLangPref(p)
    setPrefState(p)
  }, [])

  const value = useMemo<I18nValue>(() => ({ lang, pref, setPref, t: translator(lang) }), [lang, pref, setPref])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const v = useContext(I18nContext)
  if (!v) throw new Error('useI18n must be used inside <I18nProvider>')
  return v
}

/** 语言切换项,挂进左下角 UserMenu(与皮肤切换并列)。 */
export function useLanguageMenuItems(): UserMenuItem[] {
  const { pref, setPref, t } = useI18n()
  const options: LangPref[] = ['system', 'zh', 'en']
  return options.map((p) => ({
    label: `${t('menu.language', { name: t(`menu.language.${p}`) })}${p === pref ? ' ✓' : ''}`,
    onClick: () => setPref(p),
  }))
}
