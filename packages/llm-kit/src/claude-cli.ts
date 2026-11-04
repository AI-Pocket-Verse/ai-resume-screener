// Claude Code CLI 作为 LLM provider:每次调用 spawn 一个 `claude -p` 子进程,
// 解析它的 stream-json 输出。双计时器(空闲 + 硬上限)防子进程卡死,abort 会传播到子进程。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { env as procEnv } from "node:process";
import { dirname } from "node:path";
import type { ChatCallOpts, ChatChunk, ChatPrompt, LLMProvider, ProviderHealth } from "./types.js";
import { startIdleHardTimer } from "./timeout.js";

export interface ClaudeCliOpts {
  bin?: string;
  env?: NodeJS.ProcessEnv;
  /// Optional `--model` arg passed to the Claude CLI, e.g. a cheaper/faster
  /// model for background work. Falls back to the CLI's own default model
  /// when undefined.
  model?: string;
}

// 子进程只继承运行 claude CLI 必需的环境变量,不继承服务进程里的其它密钥
// (INTERNAL_API_TOKEN、数据库路径、其它厂商 key 等)。claude 本身需要的:
// 可执行文件查找(PATH)、登录态与配置目录(HOME / XDG_* / CLAUDE_* / ANTHROPIC_*)、
// 语言与时区、代理与自定义 CA(国内部署刚需)。
const CHILD_ENV_EXACT = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM", "TZ", "LANG", "LANGUAGE",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
]);
const CHILD_ENV_PREFIX = ["LC_", "XDG_", "CLAUDE_", "ANTHROPIC_"];

/** 从 src 里挑出可以传给 claude 子进程的变量(纯函数,便于测)。 */
export function claudeChildEnv(src: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    if (CHILD_ENV_EXACT.has(k) || CHILD_ENV_PREFIX.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}

// 读图时 Read 工具只放行页图所在目录:`Read(//绝对路径/**)`(双斜杠 = 文件系统绝对路径)。
// 这条规则只有在 dontAsk 权限模式下才是硬边界(见 CLAUDE_ISOLATION_ARGS):在用户的
// auto / bypassPermissions 模式下,目录外的读取可能被自动批准。CLI 版本升级后语法或行为可能变化;
// 路径里含括号或逗号时规则无法正确表达,调用方的页图目录由服务端生成,不会出现。
function readRuleFor(images: string[]): string {
  const dirs = [...new Set(images.map((p) => dirname(p)))];
  return dirs.map((d) => `Read(/${d}/**)`).join(",");
}

// 隔离参数:不论运维用户自己的 Claude Code 怎么配置,服务端调用都按同一套规则跑。
//  - --permission-mode dontAsk:未在 --allowedTools 里预先放行的调用一律拒绝。
//    不写的话会沿用用户 settings 里的权限模式(如 auto / bypassPermissions),
//    简历里的提示注入就可能让模型调用 Bash、读 .env 等。
//  - --setting-sources "":不加载用户 / 项目 / 本地 settings,也就不跑用户的 hooks、
//    不注入 CLAUDE.md 与自定义指令(会污染评分,也会把简历内容交给 hooks)。
//  - --strict-mcp-config:不加载任何 MCP server;--disable-slash-commands:不加载技能与命令。
//  - --no-session-persistence:不把会话(含简历全文)写进 ~/.claude/projects/,
//    否则「彻底删除候选人」删不到这份副本。
// 以上在 claude CLI 2.1.318 上实测:目录外读取被拒、Bash 不可用、不注入 CLAUDE.md、不落会话记录。
// CLI 升级后语法或行为可能变化,需要复核。
export const CLAUDE_ISOLATION_ARGS: readonly string[] = [
  "--permission-mode", "dontAsk",
  "--setting-sources", "",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--no-session-persistence",
];

// 选 claude CLI 的工具/轮数档位(纯函数,便于测)。优先级:webTools > images > 纯文本。
// `--tools` 决定「有哪些工具可用」,`--allowedTools` 只是「哪些调用免确认」——
// 两者都要给:只给后者时,其余工具是否能用取决于用户 settings。
//  - webTools:WebSearch/WebFetch(联网搜)+ 多轮;带图时并放开 Read 读图;
//  - images:只有 Read,且只放行页图目录 + 多轮;
//  - 纯文本:没有任何工具 + 单轮(确定性最高)。
export function claudeToolArgs(opts?: { webTools?: boolean; images?: string[]; maxTurns?: number }): string[] {
  const hasImages = !!opts?.images && opts.images.length > 0;
  if (opts?.webTools) {
    return [
      "--tools", hasImages ? "WebSearch,WebFetch,Read" : "WebSearch,WebFetch",
      `--allowedTools=WebSearch,WebFetch${hasImages ? `,${readRuleFor(opts.images!)}` : ""}`,
      `--max-turns=${opts.maxTurns ?? 6}`,
    ];
  }
  // [llm-kit 修正 1] 纯图片路径也要认 opts.maxTurns:每读一页占一个 tool_use round-trip,
  // 20 页远超 6 轮,写死会以 error_max_turns 收场且只读到前几页。
  if (hasImages) {
    return ["--tools", "Read", `--allowedTools=${readRuleFor(opts!.images!)}`, `--max-turns=${opts?.maxTurns ?? 6}`];
  }
  return ["--tools", "", "--max-turns=1"];
}

// 从一条 assistant/user 消息的 content 数组里抽联网命中的网页出处。容忍多种 claude CLI 形态:
//  - web_search_tool_result 块:content 为 [{type:"web_search_result", url, title}, ...]
//  - tool_use / server_tool_use 且 name=WebFetch:input.url(单个抓取的页面)
// 形态漂移时尽量多抽、绝不抛(出处是次要信息,缺了不影响回答)。
export function extractWebCitations(content: unknown): Array<{ url: string; title?: string }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ url: string; title?: string }> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; name?: string; input?: { url?: unknown }; content?: unknown };
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) {
        const url = (r as { url?: unknown })?.url;
        const title = (r as { title?: unknown })?.title;
        if (typeof url === "string" && url) out.push({ url, title: typeof title === "string" ? title : undefined });
      }
    } else if (b.type === "tool_use" || b.type === "server_tool_use") {
      // 容忍 CLI 版本间命名漂移:WebFetch / web_fetch / web_search 等(大小写、蛇形不一)。
      const name = (b.name ?? "").toLowerCase().replace(/_/g, "");
      if ((name === "webfetch" || name === "websearch") && typeof b.input?.url === "string" && b.input.url) {
        out.push({ url: b.input.url });
      }
    }
  }
  return out;
}

export class ClaudeCliProvider implements LLMProvider {
  readonly name = "claude" as const;
  // 最近一次对话流里 `system` 初始化事件报告的模型 ID(如 claude-opus-4-…)。
  // 仅供后台「实际检测到 X」核对提示,不参与对外显示(对外用手填 curated 名)。
  // 服务重启后、首次调用前为 null;抓不到就保持 null(不影响任何对外行为)。
  lastModel: string | null = null;
  private readonly explicitBin: string | undefined;
  private readonly explicitEnv: NodeJS.ProcessEnv | undefined;
  private readonly explicitModel: string | undefined;

  constructor(opts: ClaudeCliOpts = {}) {
    // Resolved lazily per call so tests (and admin env flips) can change
    // CLAUDE_BIN after this object is constructed.
    this.explicitBin = opts.bin;
    this.explicitEnv = opts.env;
    this.explicitModel = opts.model;
  }

  private get bin(): string {
    return this.explicitBin ?? procEnv.CLAUDE_BIN ?? "claude";
  }
  private get env(): NodeJS.ProcessEnv {
    return this.explicitEnv ?? claudeChildEnv(procEnv);
  }
  private get model(): string | undefined {
    return this.explicitModel;
  }

  async isAvailable(): Promise<ProviderHealth> {
    return new Promise((resolve) => {
      try {
        const p = spawn(this.bin, ["--version"], { env: this.env });
        let out = "";
        let stderr = "";
        p.stdout.on("data", (b: Buffer) => { out += b.toString(); });
        p.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
        p.on("error", (err) => resolve({ ok: false, reason: err.message }));
        p.on("exit", (code) => {
          if (code === 0) resolve({ ok: true, version: out.trim() });
          else resolve({ ok: false, reason: stderr.trim() || `exit ${code}` });
        });
      } catch (e) {
        resolve({ ok: false, reason: (e as Error).message });
      }
    });
  }

  chat(prompt: ChatPrompt | PromiseLike<ChatPrompt>, signal: AbortSignal, opts?: ChatCallOpts): AsyncIterable<ChatChunk> {
    // (C) Synchronous spawn so the CLI cold-start overlaps with the
    // caller's prompt prep (retrieval + build + summary refresh).
    // The async generator returned at the bottom awaits `prompt`
    // before writing stdin — by then the child is usually already
    // primed for input, so first-token latency drops by the spawn
    // cold-start (~1-3s depending on environment).
    if (signal.aborted) return abortedIterable();

    const modelArgs = this.model ? ["--model", this.model] : [];
    // Optional thinking budget control. When LLM_EFFORT is set
    // ("low"|"medium"|"high"|"xhigh"|"max"), forward it to the CLI.
    // higher = more time the model spends in `thinking` blocks before
    // answering. Unset = CLI default (currently "medium"). The
    // downstream parser surfaces thinking blocks via ChatChunk
    // {type:"thinking"}; the UI only renders a "深度思考中" indicator
    // when those events actually arrive, so flipping effort on/off
    // is the only knob needed to enable / disable the thinking UI.
    // 按调用覆盖优先(opts.effort),否则回退全局 LLM_EFFORT。让需要深度思考的调用可单独调高
    // 思考强度以展示「思考过程」,而不必抬高所有调用(专家/分诊/汇总)的延迟与成本。
    const effort = opts?.effort ?? procEnv.LLM_EFFORT;
    const effortArgs = effort ? ["--effort", effort] : [];
    // 视觉:Claude CLI 没有图片附件参数,但能用 Read 工具原生读图。带图时
    // ① 放开 Read,且用 `Read(//页图目录/**)` 限定只能读页图所在目录(纯文本仍
    // --allowedTools= 全禁)② 放开 max-turns(读图的 tool_use round-trip 每次占一轮,
    // 1 轮塞不下「读图→回答」)③ cwd 切到图片所在目录。
    // 注意:cwd 本身【不】限制 Read —— 裸 `--allowedTools=Read` 时 cwd 外的文件照样能读
    // (实测),真正起作用的是上面的路径规则。该目录里只有这份简历的页图。
    // 配合 CLAUDE_ISOLATION_ARGS 的 dontAsk 模式,路径规则之外的读取会被拒绝(2.1.318 实测);
    // 升级 CLI 后需重新核对;子进程环境变量另已精简(见 claudeChildEnv)。
    const images = opts?.images ?? [];
    const toolArgs = claudeToolArgs(opts);
    const args = [
      ...modelArgs,
      ...effortArgs,
      "-p",
      "--output-format=stream-json",
      // Claude CLI rejects "--print + stream-json" without --verbose
      // (error: "When using --print, --output-format=stream-json
      // requires --verbose"). We still discard the verbose lines —
      // only the content_block_delta JSON events are parsed downstream.
      "--verbose",
      // Without this, the CLI emits a single whole-message `assistant`
      // event with the full reply (no token-level deltas). Turning this
      // on makes it stream Anthropic-API-shaped `stream_event` frames
      // (message_start / content_block_delta / message_stop) which is
      // what the parser below expects.
      "--include-partial-messages",
      ...CLAUDE_ISOLATION_ARGS,
      ...toolArgs,
    ];
    const child = spawn(this.bin, args, {
      env: this.env,
      ...(images.length > 0 ? { cwd: dirname(images[0]!) } : {}),
    });

    // Wire exit listener FIRST so it can't be missed if the child
    // crashes during prompt prep (e.g. missing binary).
    // spawn 失败(如 CLAUDE_BIN 不存在 ENOENT)只走 'error' 事件;不监听会
    // 变成 unhandled 'error' 崩掉整个进程。记录原因,按非零退出统一上报;
    // stdin 同理(对没起来的子进程写入会在 stdin 流上再抛)。
    let spawnError: string | null = null;
    const exitPromise = new Promise<number>((res) => {
      child.on("exit", (c) => res(c ?? -1));
      child.on("error", (err) => { spawnError = err.message; res(-1); });
    });
    child.stdin.on("error", () => { /* 经 spawnError/exit 上报 */ });
    const onAbort = () => { try { child.kill("SIGTERM"); } catch { /* ignore */ } };
    signal.addEventListener("abort", onAbort);
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });

    return this.iterateStream(child, exitPromise, onAbort, () => spawnError ?? stderr, prompt, signal, images);
  }

  private async *iterateStream(
    child: ChildProcessWithoutNullStreams,
    exitPromise: Promise<number>,
    onAbort: () => void,
    getStderr: () => string,
    promptArg: ChatPrompt | PromiseLike<ChatPrompt>,
    signal: AbortSignal,
    images: string[] = [],
  ): AsyncGenerator<ChatChunk> {
    // Await prompt; on rejection or mid-wait abort, kill the
    // already-spawned child cleanly.
    let prompt: ChatPrompt;
    try {
      prompt = await Promise.resolve(promptArg);
    } catch (e) {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      signal.removeEventListener("abort", onAbort);
      yield { type: "error", message: `prompt build failed: ${(e as Error).message}` };
      return;
    }
    if (signal.aborted) {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      signal.removeEventListener("abort", onAbort);
      yield { type: "error", message: "aborted" };
      return;
    }

    // Dual timer: idle (reset on every token) + hard cap. Started
    // HERE so it doesn't count retrieval / build prep as idle time.
    // Long healthy answers no longer get SIGKILL'd mid-stream; only
    // true hangs do. See startIdleHardTimer for env knobs.
    const timer = startIdleHardTimer(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    });

    try {
      child.stdin.write(buildPromptString(prompt, images));
      child.stdin.end();
    } catch { /* 子进程未起来(spawn error)→ 经 exitPromise 分支上报 */ }

    let buffer = "";
    // Real Claude CLI 2.x stream-json schema (with --include-partial-messages):
    //   {"type":"system",...}                                          ← discarded
    //   {"type":"stream_event","event":{"type":"message_start",...}}   ← discarded
    //   {"type":"stream_event","event":{"type":"content_block_start",  ← discarded
    //                                   "index":N,"content_block":{"type":"text",...}}}
    //   {"type":"stream_event","event":{"type":"content_block_delta",  ← THIS is the token
    //                                   "index":N,
    //                                   "delta":{"type":"text_delta","text":"…"}}}
    //   {"type":"assistant","message":{...full text...}}               ← discarded (would double-count)
    //   {"type":"stream_event","event":{"type":"content_block_stop",...}}
    //   {"type":"stream_event","event":{"type":"message_stop"}}
    //   {"type":"result","subtype":"success","is_error":false,         ← fallback text + error flag
    //                    "result":"…full reply…"}
    //
    // Older parsers in this file looked for {type:"text-delta",delta:"…"},
    // a schema the CLI never actually emitted — that bug surfaced as
    // "AI replies arrive blank, no error" because the loop yielded zero
    // tokens and finished cleanly.
    let yieldedAny = false;
    let resultText = "";
    let resultError: string | null = null;
    // 联网出处去重(整条流内同一 URL 只报一次)。
    const seenUrls = new Set<string>();
    // Per-index content-block type cache. With extended thinking the
    // CLI interleaves blocks like: index=0 thinking → index=1 text.
    // We need to know which kind a delta belongs to so a text_delta
    // inside a thinking block is routed to the thinking stream
    // rather than the answer body (some CLI versions stream thinking
    // text as text_delta within a thinking block).
    const blockTypeByIndex = new Map<number, "text" | "thinking" | "other">();
    try {
      for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
        buffer += chunk.toString("utf8");
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let evt: { type?: unknown; event?: unknown; result?: unknown; is_error?: unknown; model?: unknown };
          try { evt = JSON.parse(line); } catch { continue; }
          // [llm-kit 修正 2] 原版只在 yield 出 token/thinking 时才 arm(),于是
          // 【工具轮次】完全不算「活着」:模型读一页图 = tool_use + tool_result
          // 两帧,不产生任何 text_delta。resume 喂 20 页渲染图时读图阶段能连续
          // 好几分钟没有 text token,90s 的 idle 窗口会把正常干活的 CLI 误杀。
          // idle 计时器要答的问题是「CLI 还有没有反应」,任何一帧合法事件都已
          // 经回答了「有」,所以在这里统一 arm(),下面各分支不再各自 arm。
          // 越界的长跑仍由 hard cap(600s,永不重置)兜底。
          timer.arm();
          // `system`(subtype:"init")事件带本次实际使用的 model —— 缓存供后台核对。
          if (evt.type === "system" && typeof evt.model === "string" && evt.model) {
            this.lastModel = evt.model;
          }
          if (evt.type === "stream_event" && evt.event && typeof evt.event === "object") {
            const ev = evt.event as {
              type?: string;
              index?: number;
              content_block?: { type?: string };
              delta?: { type?: string; text?: string; thinking?: string };
            };
            if (ev.type === "content_block_start" && typeof ev.index === "number") {
              const cbType = ev.content_block?.type;
              if (cbType === "text") {
                blockTypeByIndex.set(ev.index, "text");
              } else if (cbType === "thinking" || cbType === "redacted_thinking") {
                blockTypeByIndex.set(ev.index, "thinking");
                // Empty-text thinking event = "thinking started" signal.
                // The UI flips into "深度思考中" indicator even when no
                // thinking_delta follows (CLI signs but doesn't emit
                // raw reasoning for some models).
                yield { type: "thinking", text: "" };
              } else {
                blockTypeByIndex.set(ev.index, "other");
              }
            } else if (ev.type === "content_block_delta" && typeof ev.index === "number" && ev.delta) {
              const blockType = blockTypeByIndex.get(ev.index);
              const d = ev.delta;
              if (blockType === "text" && d.type === "text_delta" && typeof d.text === "string" && d.text.length > 0) {
                yield { type: "token", text: d.text };
                yieldedAny = true;
              } else if (blockType === "thinking") {
                // thinking_delta is the documented shape carrying raw
                // reasoning text. signature_delta carries opaque
                // signing data — intentionally dropped (not user-facing).
                if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking.length > 0) {
                  yield { type: "thinking", text: d.thinking };
                } else if (d.type === "text_delta" && typeof d.text === "string" && d.text.length > 0) {
                  // Defensive: some CLI builds stream thinking content
                  // as text_delta INSIDE a thinking block. Route it to
                  // the thinking lane so it doesn't pollute the answer.
                  yield { type: "thinking", text: d.text };
                }
              }
            } else if (ev.type === "content_block_stop" && typeof ev.index === "number") {
              if (blockTypeByIndex.get(ev.index) === "thinking") {
                yield { type: "thinking_end" };
              }
            }
          } else if (evt.type === "result") {
            if (typeof evt.result === "string") resultText = evt.result;
            if (evt.is_error === true) {
              resultError = (typeof evt.result === "string" && evt.result.length > 0) ? evt.result : "claude returned an error";
            }
          } else if (evt.type === "assistant" || evt.type === "user") {
            // 联网工具的命中以「完整消息」形式出现(content 数组里的 web_search_tool_result /
            // WebFetch tool_use),deltas 难拼,所以从这里的完整 message 抽 URL 出处。
            const content = (evt as { message?: { content?: unknown } }).message?.content;
            for (const c of extractWebCitations(content)) {
              if (seenUrls.has(c.url)) continue;
              seenUrls.add(c.url);
              yield { type: "citation", url: c.url, title: c.title };
            }
          }
        }
      }

      const code = await exitPromise;
      const tReason = timer.reason();
      if (tReason === "idle") yield { type: "error", message: `claude idle for ${timer.idleMs}ms (no tokens received)` };
      else if (tReason === "hard") yield { type: "error", message: `claude exceeded ${timer.hardMs}ms hard cap` };
      else if (signal.aborted) yield { type: "error", message: "aborted" };
      else if (resultError) yield { type: "error", message: resultError };
      else if (code === 0) {
        // Defensive fallback: if --include-partial-messages stopped firing
        // deltas (CLI upgrade / schema drift), at least surface the full
        // result text rather than a silent empty bubble.
        if (!yieldedAny && resultText.length > 0) yield { type: "token", text: resultText };
        // [llm-kit 新增] 最终答案全文,供结构化调用方跳过中间轮的过场白(见 types.ts)。
        // 放在 done 之前,这样 for-await 到 done 就能确定 final 已经来过(或确实没有)。
        if (resultText.length > 0) yield { type: "final", text: resultText };
        yield { type: "done" };
      }
      else yield { type: "error", message: getStderr().trim() || `claude exited ${code}` };
    } finally {
      timer.disarm();
      signal.removeEventListener("abort", onAbort);
    }
  }
}

// Returned synchronously from chat() when the signal was already
// aborted at entry — we never spawn the child at all in that case.
// Typed as AsyncGenerator (not AsyncIterable) to match the actual
// runtime value an `async function*` returns; for-await callers
// only need AsyncIterable, but the narrower type means tooling
// won't lose the .return()/.throw() methods if a future caller
// needs them.
async function* abortedIterable(): AsyncGenerator<ChatChunk> {
  yield { type: "error", message: "aborted" };
}

function buildPromptString(input: ChatPrompt, images: string[] = []): string {
  const parts: string[] = [];
  parts.push(`<SYSTEM>\n${input.systemPrompt}\n</SYSTEM>\n`);
  if (input.history.length) {
    parts.push("<HISTORY>");
    for (const m of input.history) parts.push(`<${m.role.toUpperCase()}>\n${m.content}\n</${m.role.toUpperCase()}>`);
    parts.push("</HISTORY>\n");
  }
  if (images.length > 0) {
    // 带图轮次:argv 已放开 Read 工具(见 chat()),这里告诉模型图在哪、必须先看。
    parts.push("<IMAGES>");
    parts.push("用户随本条消息上传了图片,文件路径:");
    for (const p of images) parts.push(`- ${p}`);
    parts.push("请先用 Read 工具逐一查看以上图片,再结合图片内容回答问题。回答里不要提及文件路径或读取过程。");
    parts.push("</IMAGES>\n");
  }
  parts.push(`<QUESTION>\n${input.userMessage}\n</QUESTION>`);
  return parts.join("\n");
}
