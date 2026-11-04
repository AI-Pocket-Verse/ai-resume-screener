// api 与 web 的共享契约。zod 是【单一真相源】:
//   - api 侧用它校验模型返回的 JSON,并由 z.toJSONSchema 生成喂给模型的说明书
//   - web 侧用它推导 TS 类型,不再手写一份会静默漂移的 interface
export * from './resume-schema.js'
export * from './scorecard-schema.js'
export * from './skills.js'
