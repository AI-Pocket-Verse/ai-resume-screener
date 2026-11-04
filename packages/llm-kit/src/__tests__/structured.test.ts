import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCliProvider } from "../claude-cli.js";
import { chatJson, extractJson } from "../structured.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.resolve(__dirname, "../../scripts/fake-claude.sh");

const newProvider = (env: Record<string, string> = {}) =>
  new ClaudeCliProvider({ bin: FAKE, env: { ...process.env, ...env } });

const PROMPT = { systemPrompt: "sys", history: [], userMessage: "抽取" };

describe("extractJson", () => {
  it("干净 JSON 原样返回", () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });
  it("剥 ```json 围栏", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
  // 实测形态:模型在调工具前先说一句过场白,和答案一起出现在 token 流里。
  it("截掉 JSON 前的过场白与后面的补充说明", () => {
    expect(extractJson('I\'ll read all 21 pages first.{"a":1}')).toBe('{"a":1}');
    expect(extractJson('好的,结果如下:\n{"a":1}\n以上。')).toBe('{"a":1}');
  });
  it("顶层数组也能挖出来", () => {
    expect(extractJson("前言 [1,2,3] 后记")).toBe("[1,2,3]");
  });
  it("挖不到就原样返回(交给 JSON.parse 报错)", () => {
    expect(extractJson("完全不是 JSON")).toBe("完全不是 JSON");
  });
});

describe("chatJson", () => {
  it("解析出对象", async () => {
    const r = await chatJson<{ a: number }>(
      newProvider({ FAKE_CLAUDE_REPLY: '{"a":1}' }), PROMPT, new AbortController().signal,
    );
    expect(r.error).toBeNull();
    expect(r.data).toEqual({ a: 1 });
  });

  // 这条是集成测试中发现的问题的回归:真实调用里模型先说 "I'll read all 21 pages
  // first." 再调 21 次 Read,最后才吐 JSON —— 过场白只进 token 流、不进 result 帧。
  //
  // 过场白【带花括号】是刻意的:不带的话 extractJson 的「首 { 到末 }」截取顺手
  // 就把它剥了,认不认 final 都能过,测试等于没测。带了花括号,截取会从过场白
  // 的 { 一路截到答案的 },拼出一段废话 —— 只有认 final 才拿得到干净答案。
  it("多轮工具调用:认 final 事件,不被过场白带偏", async () => {
    const p = newProvider({
      FAKE_CLAUDE_REPLY: '{"name":"李明远","projects":20}',
      FAKE_CLAUDE_PREAMBLE: "我会按 {name, projects} 的结构输出,先读完 21 页。",
      FAKE_CLAUDE_TOOLGAP: "3",
    });
    const r = await chatJson<{ name: string; projects: number }>(p, PROMPT, new AbortController().signal);
    expect(r.error).toBeNull();
    expect(r.data).toEqual({ name: "李明远", projects: 20 });
  });

  it("模型报错 → error 落字段而不是抛异常", async () => {
    const r = await chatJson(newProvider({ FAKE_CLAUDE_ERROR: "auth" }), PROMPT, new AbortController().signal);
    expect(r.data).toBeNull();
    expect(r.error).toMatch(/login|auth/i);
  });

  it("回的不是 JSON → error 落字段,rawText 留档便于排查", async () => {
    const r = await chatJson(newProvider({ FAKE_CLAUDE_REPLY: "抱歉,这份简历我读不了" }), PROMPT, new AbortController().signal);
    expect(r.data).toBeNull();
    expect(r.error).toMatch(/JSON 解析失败/);
    expect(r.rawText).toContain("读不了");
  });
});
