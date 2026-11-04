// OpenAI 兼容通道:POST {baseURL}/chat/completions,流式(SSE)读取。
// 豆包、千问、DeepSeek、智谱、Kimi、MiniMax、OpenAI 以及 Ollama 等本地服务都兼容这个格式,
// 差别只有地址、key 和模型名,所以一个实现 + 一张预设表就够,不做逐家适配。
import type { ChatCallOpts, ChatChunk, ChatPrompt, LLMProvider, ProviderHealth } from "./types.js";
import { readInlineImages } from "./images.js";
import { startIdleHardTimer } from "./timeout.js";

/** 预设厂商。`keyEnv` 是该厂商 API Key 的环境变量名,由 api 侧读取。 */
export const OPENAI_COMPATIBLE_PRESETS = {
  openai: { baseURL: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" },
  doubao: { baseURL: "https://ark.cn-beijing.volces.com/api/v3", keyEnv: "ARK_API_KEY" },
  qwen: { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", keyEnv: "QWEN_API_KEY" },
  deepseek: { baseURL: "https://api.deepseek.com", keyEnv: "DEEPSEEK_API_KEY" },
  zhipu: { baseURL: "https://open.bigmodel.cn/api/paas/v4", keyEnv: "ZHIPU_API_KEY" },
  kimi: { baseURL: "https://api.moonshot.cn/v1", keyEnv: "KIMI_API_KEY" },
  minimax: { baseURL: "https://api.minimaxi.com/v1", keyEnv: "MINIMAX_API_KEY" },
} as const;
export type OpenAICompatiblePreset = keyof typeof OPENAI_COMPATIBLE_PRESETS;

export interface OpenAICompatibleOpts {
  /** 预设名或 "openai-compatible"(自定义地址),只用于日志和报错。 */
  label: string;
  baseURL: string;
  /** 本地服务(如 Ollama)可以不要 key。 */
  apiKey?: string;
  model: string;
  /** 测试注入。 */
  fetch?: typeof fetch;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = "openai" as const;
  readonly lastModel: string;
  private readonly opts: OpenAICompatibleOpts;

  constructor(opts: OpenAICompatibleOpts) {
    this.opts = { ...opts, baseURL: opts.baseURL.replace(/\/+$/, "") };
    this.lastModel = opts.model;
  }

  async isAvailable(): Promise<ProviderHealth> {
    return { ok: true, version: `${this.opts.label} / ${this.opts.model}` };
  }

  chat(prompt: ChatPrompt | PromiseLike<ChatPrompt>, signal: AbortSignal, opts?: ChatCallOpts): AsyncIterable<ChatChunk> {
    return this.run(prompt, signal, opts);
  }

  private async *run(promptArg: ChatPrompt | PromiseLike<ChatPrompt>, signal: AbortSignal, opts?: ChatCallOpts): AsyncGenerator<ChatChunk> {
    if (signal.aborted) {
      yield { type: "error", message: "aborted" };
      return;
    }
    let body: string;
    try {
      const prompt = await Promise.resolve(promptArg);
      const images = await readInlineImages(opts?.images ?? []);
      const userContent = images.length === 0
        ? prompt.userMessage
        : [
            ...images.map((img) => ({
              type: "image_url",
              image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
            })),
            { type: "text", text: prompt.userMessage },
          ];
      body = JSON.stringify({
        model: this.opts.model,
        stream: true,
        messages: [
          { role: "system", content: prompt.systemPrompt },
          ...prompt.history,
          { role: "user", content: userContent },
        ],
      });
    } catch (e) {
      yield { type: "error", message: `prompt build failed: ${(e as Error).message}` };
      return;
    }

    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal.addEventListener("abort", onAbort);
    const timer = startIdleHardTimer(() => ac.abort());
    const label = this.opts.label;

    try {
      const res = await (this.opts.fetch ?? fetch)(`${this.opts.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body,
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const detail = (await res.text().catch(() => "")).slice(0, 500);
        yield { type: "error", message: `${label} ${res.status}: ${detail || res.statusText}` };
        return;
      }

      let text = "";
      let finish: string | null = null;
      let buffer = "";
      const decoder = new TextDecoder();
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        timer.arm();
        buffer += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let evt: {
            choices?: Array<{ delta?: { content?: unknown }; finish_reason?: string | null }>;
            error?: { message?: string };
          };
          try { evt = JSON.parse(data); } catch { continue; }
          // 部分厂商在 HTTP 200 的流里报错。
          if (evt.error) {
            yield { type: "error", message: `${label}: ${evt.error.message ?? "unknown error"}` };
            return;
          }
          const choice = evt.choices?.[0];
          const piece = choice?.delta?.content;
          if (typeof piece === "string" && piece) {
            text += piece;
            yield { type: "token", text: piece };
          }
          if (choice?.finish_reason) finish = choice.finish_reason;
        }
      }
      if (finish === "length") {
        yield { type: "error", message: `${label}: 输出达到长度上限,结果被截断` };
        return;
      }
      if (finish === "content_filter") {
        yield { type: "error", message: `${label}: 内容被厂商安全策略拦截(content_filter)` };
        return;
      }
      if (text) yield { type: "final", text };
      yield { type: "done" };
    } catch (e) {
      const reason = timer.reason();
      if (reason === "idle") yield { type: "error", message: `${label} idle for ${timer.idleMs}ms` };
      else if (reason === "hard") yield { type: "error", message: `${label} exceeded ${timer.hardMs}ms hard cap` };
      else if (signal.aborted) yield { type: "error", message: "aborted" };
      else yield { type: "error", message: `${label}: ${(e as Error).message}` };
    } finally {
      timer.disarm();
      signal.removeEventListener("abort", onAbort);
    }
  }
}
