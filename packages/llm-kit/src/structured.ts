// CLI 通道的「要一个 JSON 回来」辅助层。
//
// HTTP API 通道有 response_format: json_schema 可以约束模型,CLI 没有 —— 只能靠
// 提示词要求 + 事后清洗。清洗要处理三种实测见过的脏法:
//   ① 前后包了 ```json 围栏
//   ② 多轮工具调用时,调工具前的过场白("I'll read all 21 pages first.")混进 token 流
//   ③ 答案后面又补一句总结
// ② 靠认 final 事件(result 帧 = 最后一轮的答案)解决,① ③ 靠首 `{` / 末 `}` 截取。
import type { ChatCallOpts, ChatPrompt, LLMProvider } from "./types.js";

export interface StructuredResult<T> {
  /** 解析成功的对象;失败为 null(此时看 error / rawText 定位)。 */
  data: T | null;
  /** 清洗前的模型原文,失败时用来排查。 */
  rawText: string;
  /** 失败原因:模型报错、超时、或 JSON 解析失败。成功为 null。 */
  error: string | null;
}

/** 从模型原文里挖出 JSON:先剥 markdown 围栏,再截首个 `{`/`[` 到末个 `}`/`]`。
 *  纯函数,便于单测。挖不到就原样返回,交给 JSON.parse 去报错。 */
export function extractJson(text: string): string {
  let s = text.trim();
  // ``` 或 ```json 围栏(允许围栏外还有零星文字,所以用 replace 不用 startsWith 判断)。
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(s);
  if (fenced?.[1]) s = fenced[1].trim();
  // 首个 { 与末个 } —— 对象优先;整份是数组时退而求其次找 [ ]。
  const objStart = s.indexOf("{");
  const objEnd = s.lastIndexOf("}");
  if (objStart >= 0 && objEnd > objStart) return s.slice(objStart, objEnd + 1);
  const arrStart = s.indexOf("[");
  const arrEnd = s.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) return s.slice(arrStart, arrEnd + 1);
  return s;
}

/** 跑一次对话,把回答当 JSON 解出来。绝不抛:模型报错 / 解析失败都落到
 *  StructuredResult.error,让调用方决定重试还是降级 —— 批量跑简历时,一份坏
 *  简历不该把整批带崩。 */
export async function chatJson<T = unknown>(
  provider: LLMProvider,
  prompt: ChatPrompt | PromiseLike<ChatPrompt>,
  signal: AbortSignal,
  opts?: ChatCallOpts,
): Promise<StructuredResult<T>> {
  let streamed = "";
  let final = "";
  let error: string | null = null;

  try {
    for await (const c of provider.chat(prompt, signal, opts)) {
      if (c.type === "token") streamed += c.text;
      // final 只有 CLI provider 发;将来的 HTTP provider 不发也没关系,
      // 那条通道有 response_format,token 流本身就是干净的 JSON。
      else if (c.type === "final") final = c.text;
      else if (c.type === "error") error = c.message;
    }
  } catch (e) {
    error = (e as Error).message;
  }

  // final 优先:它是最后一轮的答案,不含中间轮的过场白。
  const rawText = final || streamed;
  if (error) return { data: null, rawText, error };
  if (!rawText.trim()) return { data: null, rawText, error: "模型没有返回任何内容" };

  try {
    return { data: JSON.parse(extractJson(rawText)) as T, rawText, error: null };
  } catch (e) {
    return { data: null, rawText, error: `JSON 解析失败: ${(e as Error).message}` };
  }
}
