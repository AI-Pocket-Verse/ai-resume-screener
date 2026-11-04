import { describe, expect, it } from 'vitest'

import { translator } from '@/i18n'
import { SKILL_EN, decisionLabel, degreeLabel, dupFieldLabel, skillLabel, stanceLabel, teamName, tierLabel, userName } from './values'

const zh = translator('zh')
const en = translator('en')

describe('degreeLabel', () => {
  it('中文界面原样显示', () => {
    expect(degreeLabel('硕士研究生', 'zh', zh)).toBe('硕士研究生')
  })
  it('英文界面翻译标准值,未知值原样显示', () => {
    expect(degreeLabel('本科', 'en', en)).toBe("Bachelor's")
    expect(degreeLabel('硕士研究生', 'en', en)).toBe("Master's")
    expect(degreeLabel('MBA', 'en', en)).toBe('MBA')
    expect(degreeLabel(null, 'en', en)).toBe('')
  })
})

describe('状态词', () => {
  it('结论 / 档位 / 倾向,未知值原样', () => {
    expect(decisionLabel('reject', zh)).toBe('淘汰')
    expect(decisionLabel('reject', en)).toBe('Reject')
    expect(decisionLabel('other', en)).toBe('other')
    expect(tierLabel('deep', en)).toBe('Deep evaluation')
    expect(stanceLabel('lean_pass', zh)).toBe('倾向放弃')
    expect(stanceLabel('new_stance', en)).toBe('new_stance')
  })
})

describe('teamName', () => {
  it('系统默认团队按语言显示,其他团队原样', () => {
    expect(teamName({ name: '默认团队', ownerId: 'system' }, en)).toBe('Default team')
    expect(teamName({ name: '默认团队', ownerId: 'system' }, zh)).toBe('默认团队')
    // 岗位里嵌套的 team 没有 ownerId,只按名字判断
    expect(teamName({ name: '默认团队' }, en)).toBe('Default team')
    // 用户自己建的同名团队不翻译
    expect(teamName({ name: '默认团队', ownerId: 'u1' }, en)).toBe('默认团队')
    expect(teamName({ name: '增长组', ownerId: 'system' }, en)).toBe('增长组')
  })
})

describe('dupFieldLabel', () => {
  it('后端中文依据按前缀换成当前语言,中文原样;未知原样', () => {
    expect(dupFieldLabel('同校同届:示例大学', translator('zh'))).toBe('同校同届:示例大学')
    expect(dupFieldLabel('同公司同期:Example Inc.', translator('en'))).toBe('same company, overlapping years: Example Inc.')
    expect(dupFieldLabel('其他', translator('en'))).toBe('其他')
  })
})

describe('skillLabel', () => {
  it('技能词表里每个中文词条都有英文;中文界面原样', async () => {
    const { ALL_SKILLS } = await import('../../../shared/src/skills')
    const zhTerms = ALL_SKILLS.filter((s) => /[一-龥]/.test(s))
    expect(zhTerms.filter((s) => !SKILL_EN[s])).toEqual([])
    expect(skillLabel('高并发', 'en')).toBe('High concurrency')
    expect(skillLabel('高并发', 'zh')).toBe('高并发')
    expect(skillLabel('Kafka', 'en')).toBe('Kafka')
  })
})

describe('userName', () => {
  it('本地模式下的本地用户按语言显示;登录模式下同名真人原样', () => {
    expect(userName('本地用户', true, en)).toBe('Local user')
    expect(userName('本地用户', true, zh)).toBe('本地用户')
    expect(userName('本地用户', false, en)).toBe('本地用户')
    expect(userName('张三', true, en)).toBe('张三')
  })
})
