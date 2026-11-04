// Anthropic API 通道:用官方 SDK 调 Messages API。流式请求,边收边计时(空闲 + 硬上限)。
import Anthropic from "@anthropic-ai/sdk";
import type { ChatCallOpts, ChatChunk, ChatPrompt, LLMProvider, ProviderHealth } from "./types.js";
import { readInlineImages } from "./images.js";
import { startIdleHardTimer } from "./timeout.js";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

// 支持服务端拒答兜底(fallbacks: "default")的模型。命中安全分类器的拒答会在同一次
// 请求里换一个模型重跑,而不是直接返回 refusal。只在官方 API 上可用,自定义 baseURL
// (代理、中转)时不带,避免对方不认这个参数直接 400。
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export interface AnthropicOpts {
  apiKey: string;
  model?: string;
  /** 自定义 API 地址(代理或兼容网关)。留空 = 官方地址。 */
  baseURL?: string;
  /** 单次回答的输出上限。简历解析结果一般在几千 token 内,16000 足够且留有余量。 */
  maxTokens?: number;
  /** 测试注入。 */
  fetch?: typeof fetch;
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  readonly lastModel: string;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly useFallbacks: boolean;

  constructor(opts: AnthropicOpts) {
    this.model = opts.model || ANTHROPIC_DEFAULT_MODEL;
    this.lastModel = this.model;
    this.maxTokens = opts.maxTokens ?? 16000;
    this.useFallbacks = !opts.baseURL && FALLBACK_MODELS.has(this.model);
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      // 超时由下面的双计时器负责;SDK 自带的重试保留(429 / 5xx / 网络错误)。
      timeout: Number(process.env.LLM_HARD_TIMEOUT_MS ?? 600_000),
    });
  }

  async isAvailable(): Promise<ProviderHealth> {
    return { ok: true, version: this.model };
  }

  chat(prompt: ChatPrompt | PromiseLike<ChatPrompt>, signal: AbortSignal, opts?: ChatCallOpts): AsyncIterable<ChatChunk> {
    return this.run(prompt, signal, opts);
  }

  private async *run(promptArg: ChatPrompt | PromiseLike<ChatPrompt>, signal: AbortSignal, opts?: ChatCallOpts): AsyncGenerator<ChatChunk> {
    if (signal.aborted) {
      yield { type: "error", message: "aborted" };
      return;
    }
    let content: Anthropic.Beta.BetaContentBlockParam[];
    let prompt: ChatPrompt;
    try {
      prompt = await Promise.resolve(promptArg);
      const images = await readInlineImages(opts?.images ?? []);
      content = [
        ...images.map((img) => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: img.mediaType, data: img.base64 },
        })),
        { type: "text" as const, text: prompt.userMessage },
      ];
    } catch (e) {
      yield { type: "error", message: `prompt build failed: ${(e as Error).message}` };
      return;
    }

    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal.addEventListener("abort", onAbort);
    const timer = startIdleHardTimer(() => ac.abort());
    const wanted = opts?.effort ?? process.env.LLM_EFFORT;
    const effort = wanted && EFFORTS.has(wanted) ? wanted : undefined;

    try {
      const stream = this.client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          system: prompt.systemPrompt,
          messages: [
            ...prompt.history.map((m) => ({ role: m.role, content: m.content })),
            { role: "user" as const, content },
          ],
          ...(effort ? { output_config: { effort: effort as "low" | "medium" | "high" | "xhigh" | "max" } } : {}),
          ...(this.useFallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
        },
        { signal: ac.signal },
      );
      let text = "";
      for await (const ev of stream) {
        timer.arm();
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta" && ev.delta.text) {
          text += ev.delta.text;
          yield { type: "token", text: ev.delta.text };
        }
      }
      const msg = await stream.finalMessage();
      if (msg.stop_reason === "refusal") {
        yield { type: "error", message: "模型拒绝回答(refusal)" };
        return;
      }
      if (msg.stop_reason === "max_tokens") {
        yield { type: "error", message: `输出超过 max_tokens=${this.maxTokens},结果被截断` };
        return;
      }
      if (text) yield { type: "final", text };
      yield { type: "done" };
    } catch (e) {
      const reason = timer.reason();
      if (reason === "idle") yield { type: "error", message: `anthropic idle for ${timer.idleMs}ms` };
      else if (reason === "hard") yield { type: "error", message: `anthropic exceeded ${timer.hardMs}ms hard cap` };
      else if (signal.aborted) yield { type: "error", message: "aborted" };
      else yield { type: "error", message: describeAnthropicError(e) };
    } finally {
      timer.disarm();
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/** 把 SDK 错误转成带状态码的可读信息,便于区分 key 错误、限流和服务端故障。 */
function describeAnthropicError(e: unknown): string {
  if (e instanceof Anthropic.APIError) return `anthropic ${e.status ?? "network"}: ${e.message}`;
  return `anthropic: ${(e as Error).message}`;
}
