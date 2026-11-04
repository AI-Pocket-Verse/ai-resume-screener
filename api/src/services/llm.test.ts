import { describe, expect, it } from 'vitest'
import { resolveLlmConfig } from './llm.js'

const base = { LLM_PROVIDER: 'claude' } as Parameters<typeof resolveLlmConfig>[0]

describe('模型配置解析', () => {
  it('默认三档都走 claude CLI,模型留空 = CLI 默认', () => {
    const c = resolveLlmConfig(base)
    expect(c.parse).toEqual({ provider: 'claude', model: undefined })
    expect(c.screen).toEqual({ provider: 'claude', model: undefined })
    expect(c.deep).toEqual({ provider: 'claude', model: undefined })
  })

  it('按用途覆盖优先于全局', () => {
    const c = resolveLlmConfig({
      ...base,
      LLM_MODEL: 'sonnet',
      LLM_PARSE_PROVIDER: 'qwen', LLM_PARSE_MODEL: 'qwen-vl-max', QWEN_API_KEY: 'k',
      LLM_DEEP_PROVIDER: 'anthropic', LLM_DEEP_MODEL: 'claude-opus-5-5', ANTHROPIC_API_KEY: 'k',
    })
    expect(c.parse).toEqual({ provider: 'qwen', model: 'qwen-vl-max' })
    expect(c.screen).toEqual({ provider: 'claude', model: 'sonnet' })
    expect(c.deep).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5' })
  })

  it('通道名不区分大小写', () => {
    expect(resolveLlmConfig({ ...base, LLM_PROVIDER: 'DeepSeek', LLM_MODEL: 'deepseek-chat', DEEPSEEK_API_KEY: 'k' }).parse.provider).toBe('deepseek')
  })

  // 配错要在启动时当场知道,而不是静默退回 claude、悄悄烧别的额度。
  it('不认识的通道 → 拒绝,并列出可选值', () => {
    expect(() => resolveLlmConfig({ ...base, LLM_PROVIDER: 'gemini' })).toThrow(/不支持的通道[\s\S]*doubao/)
  })

  it('缺 key / 缺模型名逐条列出', () => {
    const run = () => resolveLlmConfig({ ...base, LLM_PROVIDER: 'doubao' })
    expect(run).toThrow(/ARK_API_KEY/)
    expect(run).toThrow(/需要模型名/)
    expect(() => resolveLlmConfig({ ...base, LLM_DEEP_PROVIDER: 'anthropic' })).toThrow(/精评[\s\S]*ANTHROPIC_API_KEY/)
  })

  it('openai 通道指向自定义地址(如本地 Ollama)时可以不配 key', () => {
    const c = resolveLlmConfig({ ...base, LLM_PROVIDER: 'openai', LLM_MODEL: 'qwen2.5vl', OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1' })
    expect(c.parse).toEqual({ provider: 'openai', model: 'qwen2.5vl' })
    expect(() => resolveLlmConfig({ ...base, LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-5' })).toThrow(/OPENAI_API_KEY/)
  })

  it('anthropic 通道不填模型 → 用默认模型,不报错', () => {
    expect(resolveLlmConfig({ ...base, LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' }).parse).toEqual({ provider: 'anthropic', model: undefined })
  })
})
