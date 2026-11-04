import { z } from 'zod'

/** 把 zod schema 转成喂给模型的 JSON Schema 文本(draft-7,内联展开、不用 $ref)。
 *
 *  - `io: 'input'`:带 `.default()` 的字段对模型是可选的(缺了由 zod 补默认值)。
 *  - 对象一律 `additionalProperties: false`:告诉模型不要自创字段。zod 4 在 input 模式下
 *    不再输出这一项,这里补回,让喂给模型的说明书与 zod-to-json-schema 时代保持一致。
 *  - 去掉 zod 4 给 `.int()` 自动加的安全整数上限,它对模型没有信息量。
 *  - `unrepresentable: 'any'`:transform / preprocess 这类无法表达的节点按任意值处理,不抛错。 */
export function modelJsonSchema(schema: z.ZodType): string {
  return JSON.stringify(
    z.toJSONSchema(schema, {
      target: 'draft-7',
      io: 'input',
      unrepresentable: 'any',
      reused: 'inline',
      override: ({ jsonSchema: s }) => {
        if (s.type === 'object' && s.additionalProperties === undefined) s.additionalProperties = false
        if (s.maximum === Number.MAX_SAFE_INTEGER) delete s.maximum
        if (s.minimum === Number.MIN_SAFE_INTEGER) delete s.minimum
      },
    }),
  )
}
