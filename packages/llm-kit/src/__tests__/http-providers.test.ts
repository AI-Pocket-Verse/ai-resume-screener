import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AnthropicProvider } from "../anthropic.js";
import { OpenAICompatibleProvider } from "../openai-compatible.js";
import { chatJson } from "../structured.js";

const PROMPT = { systemPrompt: "SYS", history: [], userMessage: "解析这份简历" };

/** 构造一个返回 SSE 流的假 fetch,并记录请求。 */
function sseFetch(lines: string[], status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const l of lines) c.enqueue(new TextEncoder().encode(l));
        c.close();
      },
    });
    return new Response(status === 200 ? body : "bad key", {
      status,
      headers: { "content-type": status === 200 ? "text/event-stream" : "text/plain" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});
function pageImage(): string {
  dir = mkdtempSync(path.join(tmpdir(), "llm-img-"));
  const p = path.join(dir, "page-01.png");
  writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return p;
}

describe("OpenAICompatibleProvider", () => {
  const chunk = (content: string, finish: string | null = null) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}\n\n`;

  it("流式拼出 JSON,带图时把页图内联成 data URL", async () => {
    const { impl, calls } = sseFetch([chunk('{"a":'), chunk("1}", "stop"), "data: [DONE]\n\n"]);
    const p = new OpenAICompatibleProvider({ label: "qwen", baseURL: "https://example.com/v1/", apiKey: "k", model: "qwen-vl-max", fetch: impl });
    const r = await chatJson<{ a: number }>(p, PROMPT, new AbortController().signal, { images: [pageImage()] });
    expect(r.error).toBeNull();
    expect(r.data).toEqual({ a: 1 });
    expect(calls[0]!.url).toBe("https://example.com/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe("qwen-vl-max");
    expect(body.messages[0]).toEqual({ role: "system", content: "SYS" });
    expect(body.messages[1].content[0].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(body.messages[1].content[1]).toEqual({ type: "text", text: "解析这份简历" });
    expect(p.lastModel).toBe("qwen-vl-max");
  });

  it("纯文本时 content 是字符串,不带图片数组", async () => {
    const { impl, calls } = sseFetch([chunk("{}", "stop")]);
    const p = new OpenAICompatibleProvider({ label: "deepseek", baseURL: "https://example.com", apiKey: "k", model: "deepseek-chat", fetch: impl });
    await chatJson(p, PROMPT, new AbortController().signal);
    expect(JSON.parse(String(calls[0]!.init.body)).messages[1].content).toBe("解析这份简历");
  });

  it("HTTP 错误带厂商名和状态码", async () => {
    const { impl } = sseFetch([], 401);
    const p = new OpenAICompatibleProvider({ label: "kimi", baseURL: "https://example.com", apiKey: "bad", model: "m", fetch: impl });
    const r = await chatJson(p, PROMPT, new AbortController().signal);
    expect(r.error).toBe("kimi 401: bad key");
  });

  it("输出被截断(finish_reason=length)按失败处理,不把半截 JSON 当结果", async () => {
    const { impl } = sseFetch([chunk('{"a":', "length")]);
    const p = new OpenAICompatibleProvider({ label: "zhipu", baseURL: "https://example.com", apiKey: "k", model: "m", fetch: impl });
    const r = await chatJson(p, PROMPT, new AbortController().signal);
    expect(r.error).toMatch(/截断/);
  });

  it("不支持的图片类型直接报错,不发请求", async () => {
    const { impl, calls } = sseFetch([chunk("{}", "stop")]);
    const p = new OpenAICompatibleProvider({ label: "qwen", baseURL: "https://example.com", apiKey: "k", model: "m", fetch: impl });
    const r = await chatJson(p, PROMPT, new AbortController().signal, { images: ["/tmp/x.gif"] });
    expect(r.error).toMatch(/不支持的图片类型/);
    expect(calls).toHaveLength(0);
  });
});

describe("AnthropicProvider", () => {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const stream = (text: string, stop = "end_turn") => [
    ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
    ev("content_block_stop", { index: 0 }),
    ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 3 } }),
    ev("message_stop", {}),
  ];

  it("默认模型 claude-opus-5-5,带图、system、effort 与拒答兜底", async () => {
    const { impl, calls } = sseFetch(stream('{"ok":true}'));
    const p = new AnthropicProvider({ apiKey: "k", fetch: impl });
    const r = await chatJson<{ ok: boolean }>(p, PROMPT, new AbortController().signal, { images: [pageImage()], effort: "high" });
    expect(r.error).toBeNull();
    expect(r.data).toEqual({ ok: true });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.system).toBe("SYS");
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.fallbacks).toBe("default");
    expect(body.messages[0].content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } });
    expect(new Headers(calls[0]!.init.headers).get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
  });

  it("自定义 baseURL 时不带 fallbacks(代理可能不认)", async () => {
    const { impl, calls } = sseFetch(stream("{}"));
    const p = new AnthropicProvider({ apiKey: "k", baseURL: "https://proxy.example.com", fetch: impl });
    await chatJson(p, PROMPT, new AbortController().signal);
    expect(JSON.parse(String(calls[0]!.init.body)).fallbacks).toBeUndefined();
    expect(calls[0]!.url.startsWith("https://proxy.example.com/")).toBe(true);
  });

  it("refusal 与 max_tokens 都按失败上报", async () => {
    for (const [stop, re] of [["refusal", /拒绝/], ["max_tokens", /截断/]] as const) {
      const { impl } = sseFetch(stream('{"a":', stop));
      const r = await chatJson(new AnthropicProvider({ apiKey: "k", model: "claude-haiku-5-5", fetch: impl }), PROMPT, new AbortController().signal);
      expect(r.error).toMatch(re);
    }
  });
});
