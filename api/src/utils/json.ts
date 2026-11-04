/**
 * 容错 JSON 解析。
 *
 * 这些字段(ResumeParsed.raw / derived / editedFields、Evaluation.scores …)是
 * 模型输出经 zod 校验后落库的,理论上一定合法。但**列表接口一次读几十行**,
 * 只要有一行因为任何原因坏了 —— 早期版本写入的旧格式、迁移写坏、磁盘问题 ——
 * 裸 JSON.parse 就会让【整页】500。
 *
 * 那个失败模式特别糟:HR 看到的是整个列表打不开,既不知道是哪一行的问题,
 * 也没有任何自助绕过的办法(连"跳过这个人"都做不到)。一行坏数据的代价
 * 应该是这一行显示不全,不是所有人都用不了。
 */
export function safeParse<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

/** 对象类字段的常用形态:坏了给空对象,调用方的展开语法照常成立。 */
export function safeParseObject(text: string | null | undefined): Record<string, unknown> {
  return safeParse<Record<string, unknown>>(text, {})
}
