import { describe, expect, it } from 'vitest'
import type { ResumeExtraction } from '@ai-resume-screener/shared'
import { collectIdentifiers, normalizeEmail, normalizePhone } from './normalize.js'
import { weakMatch } from './match.js'

describe('normalizePhone', () => {
  // 同一个人用「+86 138-0013-8001」和「13800138001」投两次,不归一就是两个候选人。
  it('去区号、空格、横线、括号', () => {
    for (const raw of ['13800138001', '+86 13800138001', '138-0013-8001', '+8613800138001', '(138) 0013 8001']) {
      expect(normalizePhone(raw)).toBe('13800138001')
    }
  })

  // 宁可漏合并也不能合错:合错了要人工拆,漏了只是多一条记录。
  it('不像手机号的一律不作为去重键', () => {
    expect(normalizePhone('021-88889999')).toBeNull()
    expect(normalizePhone('12345')).toBeNull()
    expect(normalizePhone('23800001234')).toBeNull() // 不以 1 开头
    expect(normalizePhone('')).toBeNull()
  })
})

describe('normalizeEmail', () => {
  it('转小写', () => {
    expect(normalizeEmail('Zhang.San@Example.COM')).toBe('zhang.san@example.com')
  })

  // Gmail 确实把这些视为同一信箱,求职者也会用 +公司名 区分投递。
  it('Gmail 的点和 +suffix 归一', () => {
    // gmail.com / googlemail.com 是被测的归一规则本身,必须用真实域名
    expect(normalizeEmail('zhang.san+acme@gmail.com')).toBe('zhangsan@gmail.com')
    expect(normalizeEmail('zhangsan@googlemail.com')).toBe('zhangsan@gmail.com')
  })

  // 别家域名的点是有意义的,归一会把两个不同的人合成一个。
  it('非 Gmail 域名保留点', () => {
    // qq.com 用来代表「非 gmail 的真实域名」,验证只对 gmail 系归一
    expect(normalizeEmail('zhang.san@qq.com')).toBe('zhang.san@qq.com')
  })

  it('+suffix 对所有域名都剥离', () => {
    // 同上:qq.com 仅作非 gmail 域名示例
    expect(normalizeEmail('me+job@qq.com')).toBe('me@qq.com')
  })

  it('不合法的邮箱 → null', () => {
    expect(normalizeEmail('not-an-email')).toBeNull()
    expect(normalizeEmail('a@b')).toBeNull()
  })
})

describe('collectIdentifiers', () => {
  it('归一失败的丢弃,合法的保留原文用于展示', () => {
    const ids = collectIdentifiers({ phone: '138-0013-8001', email: 'bad' })
    expect(ids).toHaveLength(1)
    expect(ids[0]).toMatchObject({ kind: 'phone', valueEnc: '138-0013-8001' })
    expect(ids[0]!.valueHash).toHaveLength(64)
  })

  it('同一号码的不同写法 hash 相同', () => {
    const a = collectIdentifiers({ phone: '+86 138 0013 8001' })[0]!
    const b = collectIdentifiers({ phone: '13800138001' })[0]!
    expect(a.valueHash).toBe(b.valueHash)
  })
})

// ── 弱匹配 ────────────────────────────────────────────────────────

function person(over: {
  name?: string | null
  edu?: Array<[string, string, string]>
  work?: Array<[string, string, string]>
}): ResumeExtraction {
  return {
    basic: {
      name: over.name ?? '张伟', phone: null, email: null, city: null,
      expectedTitle: null, expectedSalary: null, summary: null,
    },
    education: (over.edu ?? []).map(([school, start, end]) => ({
      school, major: null, degree: null, fullTime: null, start, end,
    })),
    work: (over.work ?? []).map(([company, start, end]) => ({
      company, title: null, department: null, responsibilities: [], achievements: [], start, end,
    })),
    project: [], skill: [], cert: [],
    injectionSuspected: false, injectionEvidence: null,
  }
}

describe('weakMatch', () => {
  // 光凭姓名相同就提示,HR 每天要处理几十条无效提示,很快会对所有提示条视而不见 ——
  // 连真的那条也一起忽略。所以「仅姓名相同」明确不提示。
  it('仅姓名相同 → 不提示', () => {
    expect(weakMatch(person({}), person({}))).toBeNull()
  })

  it('姓名不同 → 不提示,哪怕同校同届', () => {
    const a = person({ name: '张伟', edu: [['某某大学', '2015', '2019']] })
    const b = person({ name: '李娜', edu: [['某某大学', '2015', '2019']] })
    expect(weakMatch(a, b)).toBeNull()
  })

  it('同名 + 同校同届 → 提示', () => {
    const a = person({ edu: [['某某大学', '2015', '2019']] })
    const b = person({ edu: [['某某大学', '2016', '2020']] })
    expect(weakMatch(a, b)?.matchedField).toContain('同校同届')
  })

  it('同名 + 同校但年份完全错开 → 不提示', () => {
    const a = person({ edu: [['某某大学', '2005', '2009']] })
    const b = person({ edu: [['某某大学', '2015', '2019']] })
    expect(weakMatch(a, b)).toBeNull()
  })

  it('同名 + 同公司同期 → 提示', () => {
    const a = person({ work: [['某某科技', '2020-01', '2023-01']] })
    const b = person({ work: [['某某科技', '2022-06', 'present']] })
    expect(weakMatch(a, b)?.matchedField).toContain('同公司同期')
  })

  it('同名 + 同公司但时间错开 → 不提示', () => {
    const a = person({ work: [['某某科技', '2010-01', '2012-01']] })
    const b = person({ work: [['某某科技', '2020-01', '2022-01']] })
    expect(weakMatch(a, b)).toBeNull()
  })

  it('学校优先于公司(更强的信号)', () => {
    const a = person({ edu: [['某某大学', '2015', '2019']], work: [['某某科技', '2020', '2023']] })
    const b = person({ edu: [['某某大学', '2015', '2019']], work: [['某某科技', '2020', '2023']] })
    expect(weakMatch(a, b)?.matchedField).toContain('同校同届')
  })
})
