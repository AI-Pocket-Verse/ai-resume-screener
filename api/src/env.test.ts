import { describe, expect, it } from 'vitest'
import { assertProductionConfig, parseTrustProxy } from './env.js'

// 配了通知却没换掉占位口令时,失败是静默的(服务照常起,飞书通知悄悄不工作),
// 所以生产环境启动时直接拦下。

const ok = {
  NODE_ENV: 'production',
  WHOAMI_URL: 'http://127.0.0.1:4020/api/whoami',
  AUTH_API_BASE: 'http://127.0.0.1:4020/api',
  INTERNAL_API_TOKEN: 'a'.repeat(64),
}

describe('生产配置自检', () => {
  it('配置齐全 → 放行', () => {
    expect(() => assertProductionConfig(ok)).not.toThrow()
  })

  // 非生产环境不该被拦:开发机上本来就可能没配。
  it('非生产环境一律放行', () => {
    for (const NODE_ENV of ['development', 'test']) {
      expect(() => assertProductionConfig({ ...ok, NODE_ENV, INTERNAL_API_TOKEN: '__REPLACE_ME__' })).not.toThrow()
    }
  })

  // 通知是可选功能:没配 AUTH_API_BASE 说明不用通知,不该拦。
  it('未配置 AUTH_API_BASE(不用通知)→ 放行', () => {
    expect(() => assertProductionConfig({ NODE_ENV: 'production', WHOAMI_URL: ok.WHOAMI_URL })).not.toThrow()
  })

  // 按 `__` 前缀判而不是穷举字面量 —— 否则换个占位写法就能绕过去。
  it('任何 __ 开头的占位符都拦得住,不只是某一个写法', () => {
    for (const token of ['__FILL_ME__', '__REPLACE_ME__', '__TODO__']) {
      expect(() => assertProductionConfig({ ...ok, INTERNAL_API_TOKEN: token }), token).toThrow(/INTERNAL_API_TOKEN/)
    }
  })

  it('配了 AUTH_API_BASE 却没配口令 → 拦', () => {
    expect(() => assertProductionConfig({ ...ok, INTERNAL_API_TOKEN: undefined })).toThrow(/INTERNAL_API_TOKEN/)
  })

  // 错误信息必须说清「去哪抄这个值」,只说「配置错误」的话还得翻代码。
  it('错误信息指明值的来源', () => {
    expect(() => assertProductionConfig({ ...ok, INTERNAL_API_TOKEN: '__x__' })).toThrow(/feishu-sso/)
  })

  // 部署模板是同机 nginx 从 127.0.0.1 反代,「只监听本机」这道防线在生产上不成立。
  it('生产环境未配登录 → 拦,并指明 ALLOW_NO_AUTH 出口', () => {
    expect(() => assertProductionConfig({ NODE_ENV: 'production' })).toThrow(/WHOAMI_URL[\s\S]*ALLOW_NO_AUTH=true/)
  })

  it('显式 ALLOW_NO_AUTH=true → 放行免登录', () => {
    expect(() => assertProductionConfig({ NODE_ENV: 'production', ALLOW_NO_AUTH: true })).not.toThrow()
  })
})

describe('TRUST_PROXY 解析', () => {
  it('true / false / 地址列表照常解析', () => {
    expect(parseTrustProxy('TRUE')).toBe(true)
    expect(parseTrustProxy('false')).toBe(false)
    expect(parseTrustProxy('')).toBe('loopback')
    expect(parseTrustProxy('192.0.2.0/24, 127.0.0.1')).toBe('192.0.2.0/24, 127.0.0.1')
  })
  // Fastify 5.12 起按跳数信任一律当作不信任,静默失效比报错更糟。
  it('纯数字(跳数)启动时报错', () => {
    expect(() => parseTrustProxy('1')).toThrow(/跳数/)
  })
})
