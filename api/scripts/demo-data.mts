// 演示数据:一个岗位 + 四份简历,中英文各一套。人名、公司、联系方式全部虚构
// (手机号用 1380013800x / +1 555-01xx 保留段,邮箱用 example.com)。
// 四个人刻意拉开档次:对口且资深 / 对口但缺细节 / 转岗前端 / 学历与经验都不够,
// 这样一次跑完就能看到 A-D 档分布、门槛标红和精评。

export interface DemoSet {
  job: { title: string; location: string; level: string; headcount: number; jd: string }
  resumes: Array<{ filename: string; text: string }>
}

export const DEMO: Record<'zh' | 'en', DemoSet> = {
  zh: {
    job: {
      title: '高级后端工程师',
      location: '深圳',
      level: '高级',
      headcount: 2,
      jd: `负责交易与支付核心服务的设计与开发。
要求：
1. 本科及以上学历，计算机相关专业；
2. 5 年以上后端开发经验，3 年以上 Node.js / TypeScript 经验；
3. 熟悉 MySQL、Redis、消息队列，有高并发系统设计与性能优化经验；
4. 有服务拆分或架构重构经验者优先，有带团队经验者优先。`,
    },
    resumes: [
      {
        filename: '孙七.md',
        text: `# 孙七
手机：13800138001 · 邮箱：sunqi@example.com · 城市：示例市

## 教育经历
- 示例交通大学 · 计算机科学与技术 · 硕士 · 2015.09-2018.06
- 示例交通大学 · 软件工程 · 本科 · 2011.09-2015.06

## 工作经历
### 示例电商有限公司 · 资深后端工程师 · 2021.07-至今
负责交易链路高并发改造，峰值 QPS 从 2 万提升到 8 万；主导订单服务拆分与 Kafka 异步化，带 4 人小组。
### 示例金融科技有限公司 · 后端工程师 · 2018.07-2021.06
使用 Node.js 与 TypeScript 开发支付清结算服务，日处理订单 300 万笔；维护 MySQL 分库分表与 Redis 缓存。

## 项目经历
### 订单中心重构（2022.03-2023.01）
技术栈 Node.js、TypeScript、MySQL、Redis、Kafka。单体订单服务拆分为 6 个服务，P99 延迟下降 45%。

## 技能
Node.js、TypeScript、MySQL、Redis、Kafka、Docker、Kubernetes`,
      },
      {
        filename: '李四.md',
        text: `# 李四
手机：13800138002 · 邮箱：lisi@example.com · 城市：示例市

## 教育经历
- 示例理工大学 · 软件工程 · 本科 · 2014.09-2018.06

## 工作经历
### 示例云计算有限公司 · 高级后端工程师 · 2021.04-至今
负责计费系统重构，引入消息队列，接口 P99 延迟下降 35%。
### 示例数据有限公司 · 后端工程师 · 2018.07-2021.03
使用 TypeScript 与 Node.js 开发数据接入服务，维护 MySQL 与 Redis。

## 项目经历
### 计费系统重构（2022.01-2022.10）
技术栈 Node.js、MySQL、RabbitMQ。

## 技能
Node.js、TypeScript、MySQL、Redis、RabbitMQ`,
      },
      {
        filename: '王五.md',
        text: `# 王五
手机：13800138003 · 邮箱：wangwu@example.com · 城市：示例市

## 教育经历
- 示例师范大学 · 计算机科学与技术 · 本科 · 2014.09-2018.06

## 工作经历
### 示例互联网有限公司 · 高级前端工程师 · 2022.01-至今
主导低代码平台前端架构，首屏耗时降低 40%；维护内部 Node.js BFF 服务。
### 示例软件有限公司 · 前端工程师 · 2018.07-2021.12
使用 React 与 TypeScript 开发管理后台，负责组件库建设。

## 项目经历
### 低代码平台（2022.03-2023.06）
技术栈 React、TypeScript、Node.js。

## 技能
React、TypeScript、Vite、Node.js`,
      },
      {
        filename: '赵六.md',
        text: `# 赵六
手机：13800138004 · 邮箱：zhaoliu@example.com · 城市：示例市

## 教育经历
- 示例职业技术学院 · 计算机应用技术 · 大专 · 2018.09-2021.06

## 工作经历
### 示例科技有限公司 · 后端开发工程师 · 2021.07-至今
使用 Node.js 开发内部管理系统接口，参与 MySQL 表结构设计。

## 项目经历
### 内部工单系统（2022.05-2022.12）
技术栈 Node.js、Express、MySQL。

## 技能
Node.js、JavaScript、MySQL`,
      },
    ],
  },
  en: {
    job: {
      title: 'Senior Backend Engineer',
      location: 'Remote',
      level: 'Senior',
      headcount: 2,
      jd: `Design and build the core order and payment services.
Requirements:
1. Bachelor's degree or above in computer science or a related field;
2. 5+ years of backend development, including 3+ years with Node.js / TypeScript;
3. Solid experience with MySQL, Redis and message queues, plus high-concurrency system design and performance tuning;
4. Experience splitting services or re-architecting systems is a plus; team lead experience is a plus.`,
    },
    resumes: [
      {
        filename: 'Alex Morgan.md',
        text: `# Alex Morgan
Phone: +1 555-0101 · Email: alex.morgan@example.com · City: Springfield

## Education
- Example State University · M.S. Computer Science · Master's · 2015.09-2017.06
- Example State University · B.S. Computer Science · Bachelor's · 2011.09-2015.06

## Experience
### Example Commerce Inc. · Staff Backend Engineer · 2021.07-Present
Led the high-concurrency upgrade of the checkout pipeline, raising peak QPS from 20k to 80k; split the order service and moved it to Kafka-based async processing; managed a team of 4.
### Example Fintech LLC · Backend Engineer · 2017.07-2021.06
Built payment settlement services in Node.js and TypeScript processing 3M orders a day; maintained sharded MySQL and Redis caching.

## Projects
### Order platform re-architecture (2022.03-2023.01)
Node.js, TypeScript, MySQL, Redis, Kafka. Split a monolith into 6 services and cut P99 latency by 45%.

## Skills
Node.js, TypeScript, MySQL, Redis, Kafka, Docker, Kubernetes`,
      },
      {
        filename: 'Jamie Chen.md',
        text: `# Jamie Chen
Phone: +1 555-0102 · Email: jamie.chen@example.com · City: Springfield

## Education
- Example Institute of Technology · B.S. Software Engineering · Bachelor's · 2014.09-2018.06

## Experience
### Example Cloud Co. · Senior Backend Engineer · 2021.04-Present
Rebuilt the billing system and introduced a message queue, cutting API P99 latency by 35%.
### Example Data Inc. · Backend Engineer · 2018.07-2021.03
Built data ingestion services in TypeScript and Node.js; maintained MySQL and Redis.

## Projects
### Billing system rebuild (2022.01-2022.10)
Node.js, MySQL, RabbitMQ.

## Skills
Node.js, TypeScript, MySQL, Redis, RabbitMQ`,
      },
      {
        filename: 'Taylor Brooks.md',
        text: `# Taylor Brooks
Phone: +1 555-0103 · Email: taylor.brooks@example.com · City: Springfield

## Education
- Example College · B.A. Computer Science · Bachelor's · 2014.09-2018.06

## Experience
### Example Web Co. · Senior Frontend Engineer · 2022.01-Present
Led the frontend architecture of a low-code platform and cut first-screen load time by 40%; maintained an internal Node.js BFF.
### Example Software Inc. · Frontend Engineer · 2018.07-2021.12
Built admin dashboards with React and TypeScript; owned the component library.

## Projects
### Low-code platform (2022.03-2023.06)
React, TypeScript, Node.js.

## Skills
React, TypeScript, Vite, Node.js`,
      },
      {
        filename: 'Riley Park.md',
        text: `# Riley Park
Phone: +1 555-0104 · Email: riley.park@example.com · City: Springfield

## Education
- Example Community College · A.S. Computer Programming · Associate's · 2018.09-2020.06

## Experience
### Example Tech LLC · Backend Developer · 2021.07-Present
Built internal admin APIs in Node.js and helped design MySQL schemas.

## Projects
### Internal ticketing system (2022.05-2022.12)
Node.js, Express, MySQL.

## Skills
Node.js, JavaScript, MySQL`,
      },
    ],
  },
}
