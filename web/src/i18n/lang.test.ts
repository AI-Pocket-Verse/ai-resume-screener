import { describe, expect, it } from 'vitest'

import { detectSystemLang, format, resolveLang } from './lang'
import { en, zh } from './messages'

describe('系统语言识别', () => {
  it('取第一个能识别的语言', () => {
    expect(detectSystemLang(['zh-CN', 'en-US'])).toBe('zh')
    expect(detectSystemLang(['zh-TW'])).toBe('zh')
    expect(detectSystemLang(['en-GB', 'zh-CN'])).toBe('en')
    expect(detectSystemLang(['fr-FR', 'zh-Hans-CN'])).toBe('zh')
  })
  it('都识别不了或为空时用英文', () => {
    expect(detectSystemLang(['fr-FR', 'de'])).toBe('en')
    expect(detectSystemLang([])).toBe('en')
  })
  it('固定偏好优先于系统语言', () => {
    expect(resolveLang('zh', ['en-US'])).toBe('zh')
    expect(resolveLang('en', ['zh-CN'])).toBe('en')
    expect(resolveLang('system', ['zh-CN'])).toBe('zh')
  })
})

describe('文案字典', () => {
  it('中英文 key 完全一致,且没有空文案', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const [k, v] of [...Object.entries(zh), ...Object.entries(en)]) expect(v.trim(), k).not.toBe('')
  })
  it('两种语言的占位符一致', () => {
    const vars = (s: string) => [...new Set((s.match(/\{\w+(?=[}|])/g) ?? []).map((v) => v.slice(1)))].sort()
    for (const k of Object.keys(zh) as Array<keyof typeof zh>) expect(vars(en[k]), k).toEqual(vars(zh[k]))
  })
  it('format 填变量,缺的变量原样保留', () => {
    expect(format('共 {n} 人', { n: 3 })).toBe('共 3 人')
    expect(format('{a}/{b}', { a: 1 })).toBe('1/{b}')
  })
  it('英文单复数按 n 是否为 1 选择', () => {
    expect(format('{n} {n|candidate|candidates}', { n: 1 })).toBe('1 candidate')
    expect(format('{n} {n|candidate|candidates}', { n: 0 })).toBe('0 candidates')
    expect(format('{n} {n|pt|pts}', { n: 69 })).toBe('69 pts')
    expect(format('{n|a|b}', {})).toBe('{n|a|b}')
  })
})
