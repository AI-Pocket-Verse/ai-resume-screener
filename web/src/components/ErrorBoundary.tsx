import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * 页面级错误边界。React 默认在渲染期抛异常时卸载整棵树，页面变成纯白且没有任何提示；
 * 这里兜住后给出错误信息和「重试」。
 *
 * 只兜渲染期异常。事件回调、setTimeout、Promise 里的异常 React 抓不到 ——
 * 那些本来也不会卸载组件树，该由调用处自己 catch 并给出提示。
 */
interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // 留在控制台，好让排查能拿到组件栈
    console.error('[ai-resume-screener] 页面渲染出错', error, info.componentStack)
  }

  override render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6">
        <div className="w-full max-w-md rounded-xl border border-line bg-elevated p-5 text-center shadow-sm">
          <p className="text-base font-semibold text-fg">页面出错了</p>
          <p className="mt-1.5 text-sm text-fg-muted">可以点「重试」恢复；反复出现的话，请带上下面这行信息反馈。</p>
          <p className="mt-3 break-all rounded-md bg-surface px-3 py-2 text-left font-mono text-xs text-fg-faint">
            {error.name}: {error.message}
          </p>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-4 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition-colors hover:bg-accent/90"
          >
            重试
          </button>
        </div>
      </div>
    )
  }
}
