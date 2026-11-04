// 岗位深链:飞书通知卡片的按钮与 `pnpm demo` 打印的链接都是 `/?job=<岗位 id>`
// (见 api/src/services/notify/batch.ts 的 jobUrl)。

/** 首次加载时选哪个岗位:链接指定且可见的那个,否则(没指定、无权限、已删除)第一个。 */
export function pickInitialJob<T extends { id: string }>(jobs: readonly T[], search: string): T | undefined {
  const wanted = new URLSearchParams(search).get('job')
  return (wanted ? jobs.find((j) => j.id === wanted) : undefined) ?? jobs[0]
}

/** 用过之后从地址栏去掉,否则切到别的岗位再刷新,又会被拉回链接里的那个。 */
export function clearJobParam(): void {
  const url = new URL(window.location.href)
  if (!url.searchParams.has('job')) return
  url.searchParams.delete('job')
  window.history.replaceState(window.history.state, '', url)
}
