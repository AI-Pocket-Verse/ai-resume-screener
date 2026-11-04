import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCliProvider, claudeChildEnv, claudeToolArgs, extractWebCitations } from "../claude-cli.js";

describe("claudeToolArgs", () => {
  it("webTools → 放开 WebSearch/WebFetch + 多轮", () => {
    expect(claudeToolArgs({ webTools: true })).toEqual(["--tools", "WebSearch,WebFetch", "--allowedTools=WebSearch,WebFetch", "--max-turns=6"]);
  });
  it("缺省 → 没有任何可用工具 + 单轮", () => {
    expect(claudeToolArgs()).toEqual(["--tools", "", "--max-turns=1"]);
    expect(claudeToolArgs({})).toEqual(["--tools", "", "--max-turns=1"]);
  });
  it("仅图片 → 只有 Read 可用且限定页图目录 + 多轮", () => {
    expect(claudeToolArgs({ images: ["/data/p/a/page-01.png", "/data/p/a/page-02.png"] })).toEqual(["--tools", "Read", "--allowedTools=Read(//data/p/a/**)", "--max-turns=6"]);
  });
  it("联网 + 图片 → WebSearch/WebFetch 并放开 Read(不丢图)", () => {
    expect(claudeToolArgs({ webTools: true, images: ["/data/p/a/page-01.png"] })).toEqual(["--tools", "WebSearch,WebFetch,Read", "--allowedTools=WebSearch,WebFetch,Read(//data/p/a/**)", "--max-turns=6"]);
  });
  // [llm-kit 修正 1] 的回归:纯图片路径也要认 maxTurns。多页简历一页占一个
  // Read round-trip,写死 6 轮会在第 6 页戛然而止(error_max_turns)。
  it("仅图片 + maxTurns → 覆盖轮数上限", () => {
    expect(claudeToolArgs({ images: ["/data/p/a/page-01.png"], maxTurns: 25 })).toEqual(["--tools", "Read", "--allowedTools=Read(//data/p/a/**)", "--max-turns=25"]);
  });
});

describe("claudeChildEnv", () => {
  it("只保留运行 claude 必需的变量,丢弃密钥类变量", () => {
    const out = claudeChildEnv({
      PATH: "/usr/bin", HOME: "/home/u", LANG: "zh_CN.UTF-8", LC_ALL: "C", HTTPS_PROXY: "http://127.0.0.1:7890",
      ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: "/c",
      INTERNAL_API_TOKEN: "secret", DATABASE_URL: "file:x", ADMIN_MOBILES: "13800138000", AWS_SECRET_ACCESS_KEY: "s",
    });
    expect(Object.keys(out).sort()).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "HOME", "HTTPS_PROXY", "LANG", "LC_ALL", "PATH"]);
  });
});

describe("ClaudeCliProvider 子进程环境与读图范围(真实 spawn)", () => {
  it("不继承 INTERNAL_API_TOKEN 等密钥;带图时 Read 被限定在页图目录", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "claude-env-"));
    const bin = path.join(dir, "fake.sh");
    writeFileSync(bin, `#!/bin/sh\nenv > "${dir}/env.txt"\nprintf '%s\\n' "$@" > "${dir}/args.txt"\ncat > /dev/null\necho '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'\n`);
    chmodSync(bin, 0o755);
    process.env.INTERNAL_API_TOKEN = "super-secret-token";
    try {
      const p = new ClaudeCliProvider({ bin });
      const ac = new AbortController();
      const pages = path.join(dir, "pages");
      mkdirSync(pages);
      for await (const _ of p.chat({ systemPrompt: "s", history: [], userMessage: "u" }, ac.signal, { images: [path.join(pages, "page-01.png")] })) { /* drain */ }
      const envDump = readFileSync(path.join(dir, "env.txt"), "utf8");
      expect(envDump).not.toContain("INTERNAL_API_TOKEN");
      expect(envDump).not.toContain("super-secret-token");
      expect(envDump).toMatch(/^PATH=/m);
      const argv = readFileSync(path.join(dir, "args.txt"), "utf8").split("\n");
      expect(argv).toContain(`--allowedTools=Read(/${pages}/**)`);
      // 隔离参数:不随运维用户的 Claude Code 配置变化,也不落会话记录(见 CLAUDE_ISOLATION_ARGS)。
      const at = (flag: string) => argv[argv.indexOf(flag) + 1];
      expect(at("--permission-mode")).toBe("dontAsk");
      expect(argv).toContain("--setting-sources");
      expect(at("--setting-sources")).toBe("");
      expect(at("--tools")).toBe("Read");
      for (const f of ["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]) expect(argv).toContain(f);
    } finally {
      delete process.env.INTERNAL_API_TOKEN;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extractWebCitations", () => {
  it("抽 web_search_tool_result + WebFetch;非数组/异常块 → 跳过不抛", () => {
    expect(extractWebCitations(undefined)).toEqual([]);
    expect(extractWebCitations("nope")).toEqual([]);
    const cites = extractWebCitations([
      { type: "text", text: "hi" },
      { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://x/1", title: "T1" }, { url: "" }] },
      { type: "server_tool_use", name: "WebFetch", input: { url: "https://x/2" } },
      { type: "tool_use", name: "Read", input: { url: "https://ignore" } },
    ]);
    expect(cites).toEqual([{ url: "https://x/1", title: "T1" }, { url: "https://x/2" }]);
  });
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.resolve(__dirname, "../../scripts/fake-claude.sh");

function newProvider(env: Record<string, string> = {}): ClaudeCliProvider {
  return new ClaudeCliProvider({ bin: FAKE, env: { ...process.env, ...env } });
}

async function collect(provider: ClaudeCliProvider, msg: string) {
  const out: string[] = [];
  const thinking: string[] = [];
  const citations: { url: string; title?: string }[] = [];
  let thinkingStartedCount = 0;
  let thinkingEnded = false;
  let done = false;
  let err: string | null = null;
  const ac = new AbortController();
  for await (const chunk of provider.chat({
    systemPrompt: "sys", history: [], userMessage: msg,
  }, ac.signal)) {
    if (chunk.type === "token") out.push(chunk.text);
    else if (chunk.type === "thinking") {
      if (chunk.text === "") thinkingStartedCount += 1;
      else thinking.push(chunk.text);
    }
    else if (chunk.type === "thinking_end") thinkingEnded = true;
    else if (chunk.type === "citation") citations.push({ url: chunk.url, title: chunk.title });
    else if (chunk.type === "done") done = true;
    else if (chunk.type === "error") err = chunk.message;
  }
  return { text: out.join(""), thinking: thinking.join(""), citations, thinkingStartedCount, thinkingEnded, done, err };
}

describe("ClaudeCliProvider", () => {
  it("isAvailable returns ok with version", async () => {
    const h = await newProvider().isAvailable();
    expect(h.ok).toBe(true);
    expect(h.version).toBeTruthy();
  });

  it("isAvailable reports missing binary", async () => {
    const h = await new ClaudeCliProvider({ bin: "/nope/missing" }).isAvailable();
    expect(h.ok).toBe(false);
    expect(h.reason).toMatch(/not found|ENOENT|missing/i);
  });

  it("streams tokens and ends with done", async () => {
    const r = await collect(newProvider({ FAKE_CLAUDE_REPLY: "abcdef" }), "hi");
    expect(r.text).toBe("abcdef");
    expect(r.done).toBe(true);
    expect(r.err).toBeNull();
  });

  it("yields error when CLI exits non-zero (auth failure)", async () => {
    const r = await collect(newProvider({ FAKE_CLAUDE_ERROR: "auth" }), "hi");
    expect(r.done).toBe(false);
    expect(r.err).toMatch(/login|auth/i);
  });

  it("aborts when signal fires (abort right after first token)", async () => {
    // Use a hang script so the binary stays alive past the first token,
    // then abort deterministically on first token rather than racing a
    // 5ms timer that may not fire on a loaded CI runner.
    const p = newProvider({ FAKE_CLAUDE_REPLY: "abcd-rest-of-reply-that-never-arrives", FAKE_CLAUDE_HANG: "1" });
    const ac = new AbortController();
    const iter = p.chat({ systemPrompt: "", history: [], userMessage: "go" }, ac.signal);
    let errored = false;
    let aborted = false;
    for await (const c of iter) {
      if (c.type === "token" && !aborted) { aborted = true; ac.abort(); }
      if (c.type === "error") errored = true;
    }
    expect(errored).toBe(true);
  });

  it("surfaces thinking start/end even when no thinking_delta text follows (signature-only case)", async () => {
    // Matches what Claude CLI currently emits for extended-thinking
    // models on this machine: a thinking block opens, gets only a
    // signature_delta (which the parser drops), then closes — no
    // raw reasoning text leaks. The UI still needs the open/close
    // signals so it can flip a "深度思考中" badge on and off; this
    // test guards that path.
    const r = await collect(newProvider({ FAKE_CLAUDE_REPLY: "answer", FAKE_CLAUDE_THINKING: "1" }), "hi");
    expect(r.thinkingStartedCount).toBe(1);
    expect(r.thinking).toBe("");
    expect(r.thinkingEnded).toBe(true);
    expect(r.text).toBe("answer");
    expect(r.done).toBe(true);
  });

  it("streams thinking text deltas before the answer (full extended-thinking case)", async () => {
    // Future-proof: when CLI surfaces raw thinking_delta text we
    // route it to the thinking lane (NOT the answer body) so the
    // user's bubble doesn't get polluted with reasoning prose.
    const r = await collect(newProvider({ FAKE_CLAUDE_REPLY: "result", FAKE_CLAUDE_THINKING: "let me reason about this..." }), "hi");
    expect(r.thinkingStartedCount).toBe(1);
    expect(r.thinking).toBe("let me reason about this...");
    expect(r.thinkingEnded).toBe(true);
    expect(r.text).toBe("result");
  });

  it("emits web citations from web_search_tool_result / WebFetch, deduped", async () => {
    const r = await collect(newProvider({ FAKE_CLAUDE_REPLY: "答案", FAKE_CLAUDE_WEB: "1" }), "hi");
    expect(r.text).toBe("答案");
    expect(r.done).toBe(true);
    // 三条命中里 https://a.example/1 重复一次 → 去重后 3 个 URL。
    expect(r.citations.map((c) => c.url)).toEqual(["https://a.example/1", "https://a.example/2", "https://b.example/doc"]);
    expect(r.citations[0]?.title).toBe("页面一");
  });

  // [llm-kit 修正 2] 的回归。工具轮次(读图)不产生任何 text_delta,原实现在这
  // 段空窗里不 arm() idle 计时器 —— 读 20 页图的正常调用会被当成「CLI 挂了」
  // 杀掉。这里 6 个 tool_use 帧跨约 0.9s,idle 窗口设 300ms:只要工具帧算
  // liveness 就能跑完,否则第 2 个帧之前就会 idle 超时。
  it("工具轮次(无 text token)也刷新 idle 窗口,不误杀", async () => {
    process.env.LLM_TIMEOUT_MS = "300";
    try {
      const r = await collect(newProvider({ FAKE_CLAUDE_REPLY: "读完了", FAKE_CLAUDE_TOOLGAP: "6" }), "看图");
      expect(r.err).toBeNull();
      expect(r.done).toBe(true);
      expect(r.text).toBe("读完了");
    } finally {
      delete process.env.LLM_TIMEOUT_MS;
    }
  });

  it("idle timeout kills the child (no tokens received)", async () => {
    // LLM_TIMEOUT_MS is still honored as a legacy alias for the IDLE
    // window (see startIdleHardTimer); 50ms is short enough that the
    // hang script triggers the idle branch before the hard cap.
    process.env.LLM_TIMEOUT_MS = "50";
    try {
      const p = newProvider({ FAKE_CLAUDE_HANG: "1" });
      const ac = new AbortController();
      let err: string | null = null;
      for await (const c of p.chat({ systemPrompt: "", history: [], userMessage: "go" }, ac.signal)) {
        if (c.type === "error") err = c.message;
      }
      expect(err).toMatch(/idle for \d+ms/);
    } finally {
      delete process.env.LLM_TIMEOUT_MS;
    }
  });
});
