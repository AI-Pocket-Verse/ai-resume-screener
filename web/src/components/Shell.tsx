import type { ReactNode } from 'react'

import { UserMenu } from '@ai-resume-screener/auth-client-web'

import { useI18n, useLanguageMenuItems } from '@/i18n'
import { useSkinMenuItems } from '@/lib/skin'

import { ErrorBoundary } from './ErrorBoundary'

/** 产品标：文档 + 漏斗，从一堆简历里筛出人。 */
function ResumeMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-[18px] w-[18px]"
    >
      <path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3" />
      <path d="M13.5 3 19 8.5V11" />
      <path d="M8.5 8h2.5M8.5 11.5h4M8.5 15h3" />
      <path d="M13.5 14h7l-2.6 3v3.2l-1.8-1V17l-2.6-3Z" />
    </svg>
  )
}

interface Props {
  title: string
  subtitle?: ReactNode
  /** 顶栏右侧的页面动作 */
  actions?: ReactNode
  children: ReactNode
}

/**
 * 外壳：左侧固定窄栏（产品标 + 底部用户菜单）+ 右侧顶栏（标题、副标题、动作）+ 内容区。
 * 内容区不加内边距，由页面自己决定布局。
 */
export function Shell({ title, subtitle, actions, children }: Props) {
  const { t } = useI18n()
  const menuItems = [...useLanguageMenuItems(), ...useSkinMenuItems()]
  return (
    <div className="flex h-screen bg-bg text-fg">
      <aside className="flex w-[64px] shrink-0 flex-col items-center border-r border-line bg-surface p-3">
        <div className="mb-3 flex h-11 items-center" title={t('shell.productName')}>
          <span className="grid h-7 w-7 place-items-center rounded-md bg-accent text-accent-fg">
            <ResumeMark />
          </span>
        </div>
        <div className="flex-1" />
        {/* 触发器贴着视口底，必须向上展开 */}
        <div className="mt-3 border-t border-line pt-3">
          <UserMenu
            avatarOnly
            placement="top-start"
            items={menuItems}
            labels={{ login: t('menu.login'), settings: t('menu.settings'), logout: t('menu.logout'), localUser: t('user.local') }}
          />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line px-6">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold leading-tight text-fg">{title}</h1>
            {subtitle ? <div className="mt-0.5 truncate text-sm text-fg-muted">{subtitle}</div> : null}
          </div>
          {actions ? <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">
          <ErrorBoundary>{children}</ErrorBoundary>
        </main>
      </div>
    </div>
  )
}
