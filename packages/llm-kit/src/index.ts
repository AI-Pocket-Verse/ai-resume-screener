// @ai-resume-screener/llm-kit —— LLM 调用层。
//
// claude-cli.ts 把 Claude Code CLI 包成 LLMProvider:双计时器、stream-json 解析、abort 传播。
// 代码里 `// [llm-kit 修正 N]` / `[llm-kit 新增]` 标注的是喂多页简历图时实测暴露的问题:
// ① 纯图片路径不认 maxTurns ② 工具轮次不刷新 idle 窗口 ③ 多轮的过场白混进答案(新增 final 事件解决)。
//
// structured.ts:CLI 没有 response_format,要拿到可解析的 JSON 得靠「认 final 事件 + 剥围栏 + 截取」,
// 每次解析/评分都要用。
//
// 三条通道实现同一个 LLMProvider 接口:
//   - claude-cli.ts:本机 Claude Code CLI(默认,用 Claude 订阅登录即可)
//   - anthropic.ts:Anthropic Messages API(官方 SDK)
//   - openai-compatible.ts:OpenAI 兼容的 /chat/completions(豆包、千问、DeepSeek、智谱、Kimi、MiniMax、OpenAI、Ollama 等)
export { CLAUDE_ISOLATION_ARGS, ClaudeCliProvider, claudeToolArgs, extractWebCitations, type ClaudeCliOpts } from "./claude-cli.js";
export { ANTHROPIC_DEFAULT_MODEL, AnthropicProvider, type AnthropicOpts } from "./anthropic.js";
export {
  OPENAI_COMPATIBLE_PRESETS,
  OpenAICompatibleProvider,
  type OpenAICompatibleOpts,
  type OpenAICompatiblePreset,
} from "./openai-compatible.js";
export { startIdleHardTimer, type IdleHardTimer } from "./timeout.js";
export { chatJson, extractJson, type StructuredResult } from "./structured.js";
export type {
  ChatCallOpts,
  ChatChunk,
  ChatHistoryMessage,
  ChatPrompt,
  LLMProvider,
  ProviderHealth,
} from "./types.js";
