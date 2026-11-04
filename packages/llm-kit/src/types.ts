export type ChatChunk =
  | { type: "token"; text: string }
  // Extended-thinking signal from models that support it (e.g. Claude
  // with --effort high|max). Two flavors:
  //   - { type: "thinking", text: "" }  — emitted once when the
  //     thinking content block opens. Lets the UI flip into a
  //     "deep-thinking" indicator even when no thinking_delta text
  //     follows (Claude Code CLI currently only signs the thinking
  //     block; raw reasoning text is not surfaced for some models).
  //   - { type: "thinking", text: "..." } — incremental thinking
  //     text. Concat in order to render the reasoning trace.
  // Non-thinking providers/models simply never yield this variant,
  // so the UI never shows the indicator. That's the "only thinking
  // models display thinking" rule, enforced by absence.
  | { type: "thinking"; text: string }
  // Paired with the first "thinking" event: marks the end of the
  // thinking block so the UI can stop pulsing and collapse the card.
  | { type: "thinking_end" }
  // 联网出处:当放开 WebSearch/WebFetch(webTools)时,模型联网命中的网页 URL。
  // 放开 web 工具的调用可能触发。供上层做「出处」。
  | { type: "citation"; url: string; title?: string }
  // [llm-kit 新增] CLI 汇报的【最终答案全文】(stream-json 的 result 帧)。
  //
  // 为什么需要它:多轮工具调用里,模型在调工具【之前】往往先说一句过场白
  // ("I'll read all 21 pages first."),这句和最后一轮的正式答案都会以
  // text_delta 出现,于是 token 流拼出来是「过场白 + 答案」。聊天 UI 无所谓
  // (用户看到过程反而自然),但要把答案当 JSON 解析就会当场炸 —— 这是 resume
  // 喂 21 页简历图时实测到的。
  // result 帧只含最后一轮的答案,所以结构化调用认这个、不认 token 拼接。
  // 流式调用方忽略本事件即可,行为与不加时完全一致。
  | { type: "final"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

// What the provider needs to send to the model. Signal lives
// separately on the provider call (see LLMProvider.chat) so the
// caller can hand chat() a Promise<ChatPrompt> — that lets the
// provider start spawning the CLI / opening the HTTP connection
// while retrieval and prompt-build still finish in the background.
// Net: ~1-3s shaved off TTFB on cold spawns.
export interface ChatPrompt {
  systemPrompt: string;
  history: ChatHistoryMessage[];
  userMessage: string;
}

export interface ProviderHealth {
  ok: boolean;
  reason?: string;
  version?: string;
}

// Per-call options that must be known at SPAWN time(argv / cwd 在 prompt
// promise 解析前就已固定 —— 见 chat() 的同步 spawn 说明),所以不能放进
// ChatPrompt,由调用方在 chat() 调用时同步给出。
export interface ChatCallOpts {
  /** 随消息附带的图片【绝对路径】(已落盘的本地文件)。视觉能力按 provider 实现:
   *  claude CLI 放开 Read 工具 + 多轮,让模型自己读图;HTTP 通道把图片 base64 内联进消息。
   *  空/缺省 = 纯文本(行为与现状完全一致)。 */
  images?: string[];
  /** 需要联网的调用:放开 claude 的 WebSearch/WebFetch 工具 + 多轮,
   *  让模型自己联网搜。缺省 = 工具全禁、单轮。只有 claude CLI 通道支持,其余通道忽略。 */
  webTools?: boolean;
  /** 思考强度("low"|"medium"|"high"|"xhigh"|"max")。给定则【按调用覆盖】全局 LLM_EFFORT,
   *  让特定调用(如想展示思考过程)单独调高,而不必抬高所有调用的延迟/成本。
   *  缺省 = 回退 LLM_EFFORT(再缺省 = 模型默认)。claude CLI 与 anthropic 通道支持,openai 兼容通道忽略。 */
  effort?: string;
  /** 覆盖 webTools 路径的 CLI --max-turns(工具 round-trip 轮数上限)。缺省 6。
   *  多页简历读图时按页数调高,避免过早 error_max_turns。只有 claude CLI 通道使用。 */
  maxTurns?: number;
}

export interface LLMProvider {
  readonly name: "claude" | "anthropic" | "openai";
  /** 实际使用的模型 ID,随评估结果落库。HTTP 通道是配置的模型名;CLI 通道取自
   *  最近一次调用的 init 事件,首次调用前为 null。 */
  readonly lastModel: string | null;
  isAvailable(): Promise<ProviderHealth>;
  // chat() begins its connection / process spawn SYNCHRONOUSLY when
  // called, then awaits `prompt` before sending it. Callers that
  // pass a Promise<ChatPrompt> get the spawn overlapped with their
  // own prompt prep (retrieval, build, summary refresh) — no extra
  // work for callers who already have a resolved prompt: a plain
  // ChatPrompt also works because await on a non-promise is free.
  //
  // The idle / hard timers inside the provider DO NOT start until
  // the prompt has been sent — long retrieval times don't get
  // mis-attributed as "CLI hung".
  chat(prompt: ChatPrompt | PromiseLike<ChatPrompt>, signal: AbortSignal, opts?: ChatCallOpts): AsyncIterable<ChatChunk>;
}
