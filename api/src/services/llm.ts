import {
  AnthropicProvider,
  ANTHROPIC_DEFAULT_MODEL,
  ClaudeCliProvider,
  OPENAI_COMPATIBLE_PRESETS,
  OpenAICompatibleProvider,
  type LLMProvider,
  type OpenAICompatiblePreset,
} from '@ai-resume-screener/llm-kit'
import { env, type Env } from '../env.js'

/**
 * 按用途取 provider。解析 / 粗评 / 精评三档各自可以配不同的通道和模型
 * (例如解析用视觉模型、粗评用便宜模型、精评用最强模型),调用方只按用途取,
 * 换模型只改配置,解析与评估链路不动。
 */
export type LlmPurpose = 'parse' | 'screen' | 'deep'
export const LLM_PURPOSES: readonly LlmPurpose[] = ['parse', 'screen', 'deep']

const OPENAI_PRESETS = Object.keys(OPENAI_COMPATIBLE_PRESETS) as OpenAICompatiblePreset[]
export const LLM_PROVIDERS = ['claude', 'anthropic', ...OPENAI_PRESETS] as const
export type LlmProviderName = (typeof LLM_PROVIDERS)[number]

export interface LlmChannel {
  provider: LlmProviderName
  /** 模型名;claude 通道为空 = 用 CLI 自己的默认模型。 */
  model: string | undefined
}

type LlmEnv = Pick<
  Env,
  | 'LLM_PROVIDER' | 'LLM_MODEL'
  | 'LLM_PARSE_PROVIDER' | 'LLM_PARSE_MODEL'
  | 'LLM_SCREEN_PROVIDER' | 'LLM_SCREEN_MODEL'
  | 'LLM_DEEP_PROVIDER' | 'LLM_DEEP_MODEL'
  | 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | 'OPENAI_BASE_URL'
  | 'ARK_API_KEY' | 'QWEN_API_KEY' | 'DEEPSEEK_API_KEY' | 'ZHIPU_API_KEY' | 'KIMI_API_KEY' | 'MINIMAX_API_KEY'
>

const PURPOSE_LABEL: Record<LlmPurpose, string> = { parse: '解析', screen: '粗评', deep: '精评' }
const PURPOSE_KEY: Record<LlmPurpose, 'PARSE' | 'SCREEN' | 'DEEP'> = { parse: 'PARSE', screen: 'SCREEN', deep: 'DEEP' }

function presetKey(e: LlmEnv, p: OpenAICompatiblePreset): string | undefined {
  return e[OPENAI_COMPATIBLE_PRESETS[p].keyEnv as keyof LlmEnv] as string | undefined
}

/**
 * 解析三档用途的通道配置。**配错直接抛错并列出全部问题**,在启动时就暴露:
 * 静默退回默认通道会让人以为在用 A 模型,实际一直在烧 B 的额度。
 * 纯函数(只读传入的 env),便于测试。
 */
export function resolveLlmConfig(e: LlmEnv): Record<LlmPurpose, LlmChannel> {
  const problems: string[] = []
  const out = {} as Record<LlmPurpose, LlmChannel>
  for (const purpose of LLM_PURPOSES) {
    const k = PURPOSE_KEY[purpose]
    const name = (e[`LLM_${k}_PROVIDER`] ?? e.LLM_PROVIDER).trim().toLowerCase()
    const model = (e[`LLM_${k}_MODEL`] ?? e.LLM_MODEL)?.trim() || undefined
    const where = `${PURPOSE_LABEL[purpose]}(LLM_${k}_PROVIDER / LLM_PROVIDER)`
    if (!(LLM_PROVIDERS as readonly string[]).includes(name)) {
      problems.push(`${where} = ${name}:不支持的通道,可选 ${LLM_PROVIDERS.join(' / ')}`)
      continue
    }
    const provider = name as LlmProviderName
    if (provider === 'anthropic' && !e.ANTHROPIC_API_KEY) {
      problems.push(`${where} = anthropic:需要 ANTHROPIC_API_KEY`)
    }
    if (provider !== 'claude' && provider !== 'anthropic') {
      const preset = provider as OpenAICompatiblePreset
      // openai 通道指向自定义地址(如本地 Ollama)时可以不要 key。
      const keyOptional = preset === 'openai' && !!e.OPENAI_BASE_URL
      if (!keyOptional && !presetKey(e, preset)) {
        problems.push(`${where} = ${preset}:需要 ${OPENAI_COMPATIBLE_PRESETS[preset].keyEnv}`)
      }
      if (!model) problems.push(`${where} = ${preset}:需要模型名(LLM_${k}_MODEL 或 LLM_MODEL)`)
    }
    out[purpose] = { provider, model }
  }
  if (problems.length > 0) {
    throw new Error(`[resume-api] 模型配置有误,拒绝启动:\n  - ${problems.join('\n  - ')}\n  (改 api/.env.dev 或 api/.env.prod 后重启,说明见 README「模型配置」)`)
  }
  return out
}

let config: Record<LlmPurpose, LlmChannel> | null = null
/** 当前进程的通道配置(首次调用时解析并缓存)。 */
export function llmConfig(): Record<LlmPurpose, LlmChannel> {
  config ??= resolveLlmConfig(env)
  return config
}

/** 每种「通道 + 模型」一个长期实例:ClaudeCliProvider 的 lastModel 要靠实例保持。 */
const instances = new Map<string, LLMProvider>()

function create({ provider, model }: LlmChannel): LLMProvider {
  if (provider === 'claude') {
    return new ClaudeCliProvider({ ...(env.CLAUDE_BIN ? { bin: env.CLAUDE_BIN } : {}), ...(model ? { model } : {}) })
  }
  if (provider === 'anthropic') {
    return new AnthropicProvider({
      apiKey: env.ANTHROPIC_API_KEY!,
      model: model ?? ANTHROPIC_DEFAULT_MODEL,
      ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
    })
  }
  const preset = OPENAI_COMPATIBLE_PRESETS[provider]
  return new OpenAICompatibleProvider({
    label: provider,
    baseURL: provider === 'openai' && env.OPENAI_BASE_URL ? env.OPENAI_BASE_URL : preset.baseURL,
    apiKey: presetKey(env, provider),
    model: model!,
  })
}

export function getProvider(purpose: LlmPurpose): LLMProvider {
  const ch = llmConfig()[purpose]
  const key = `${ch.provider}:${ch.model ?? ''}`
  let p = instances.get(key)
  if (!p) {
    p = create(ch)
    instances.set(key, p)
  }
  return p
}

/** 启动日志用的一行描述,如「解析 qwen / qwen-vl-max」。 */
export function describeChannel(purpose: LlmPurpose): string {
  const ch = llmConfig()[purpose]
  const model = ch.model ?? (ch.provider === 'anthropic' ? ANTHROPIC_DEFAULT_MODEL : 'CLI 默认模型')
  return `${PURPOSE_LABEL[purpose]} ${ch.provider} / ${model}`
}
