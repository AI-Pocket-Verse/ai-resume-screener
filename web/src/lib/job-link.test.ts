import { describe, expect, it } from 'vitest'
import { pickInitialJob } from './job-link'

// 通知卡片的「查看结果」链到 /?job=<id>;以前前端无视参数,总是落在第一个岗位。
const jobs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

describe('pickInitialJob', () => {
  it('链接指定且可见的岗位', () => {
    expect(pickInitialJob(jobs, '?job=b')?.id).toBe('b')
    expect(pickInitialJob(jobs, '?x=1&job=c')?.id).toBe('c')
  })
  it('没指定、无权限或已删除 → 第一个', () => {
    expect(pickInitialJob(jobs, '')?.id).toBe('a')
    expect(pickInitialJob(jobs, '?job=')?.id).toBe('a')
    expect(pickInitialJob(jobs, '?job=gone')?.id).toBe('a')
  })
  it('没有岗位 → 不选', () => {
    expect(pickInitialJob([], '?job=b')).toBeUndefined()
  })
})
