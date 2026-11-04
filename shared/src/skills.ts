// 技能受控词表。
//
// **为什么必须有**:多次实测证明开放式列举不稳定 —— 同一份简历纵向跑两次得
// 8 项 vs 5 项;横向换投喂方式跨度达 3 倍;渲染图路径甚至出现 0 vs 8。
// 与投喂方式无关,是「自由列举」这个任务本身没有稳定的停止条件:
// 模型不知道该列 5 个还是 50 个。
//
// 给定词表后任务变成【判断题】(这份简历命中了词表里的哪些),同一份简历跑几次
// 结果一致,不同简历之间也才可比 —— 而「可比」正是筛选产品的立身之本。
//
// 维护方式:这是初始词表,按实际招聘方向增补。**只增不改名** —— 改名会让历史
// 解析结果里的旧名成为孤儿(它们已经落库,不会随词表更新)。
export const SKILL_VOCABULARY = {
  语言: [
    'Java', 'Go', 'Python', 'JavaScript', 'TypeScript', 'C', 'C++', 'C#',
    'Rust', 'Kotlin', 'Swift', 'PHP', 'Ruby', 'Scala', 'Objective-C', 'Dart', 'SQL', 'Shell',
  ],
  后端框架: [
    'Spring', 'Spring Boot', 'Spring Cloud', 'MyBatis', 'Netty', 'Dubbo',
    'Gin', 'gRPC', 'Django', 'Flask', 'FastAPI', 'Express', 'NestJS', 'Koa', 'Laravel', 'Rails',
  ],
  前端: [
    'React', 'Vue', 'Angular', 'Svelte', 'Next.js', 'Nuxt', 'Webpack', 'Vite',
    'Tailwind CSS', 'Redux', 'jQuery', 'Flutter', 'React Native', 'Electron', '微信小程序',
  ],
  数据存储: [
    'MySQL', 'PostgreSQL', 'Oracle', 'SQL Server', 'SQLite', 'MongoDB', 'Redis',
    'Elasticsearch', 'ClickHouse', 'HBase', 'Cassandra', 'TiDB', 'Neo4j', 'InfluxDB',
  ],
  消息与中间件: [
    'Kafka', 'RabbitMQ', 'RocketMQ', 'Pulsar', 'ActiveMQ', 'NATS', 'ZooKeeper', 'etcd', 'Nginx',
  ],
  云与运维: [
    'Docker', 'Kubernetes', 'Istio', 'Jenkins', 'GitLab CI', 'GitHub Actions',
    'Terraform', 'Ansible', 'Prometheus', 'Grafana', 'ELK', 'SkyWalking',
    'AWS', '阿里云', '腾讯云', '华为云', 'Azure', 'GCP',
  ],
  大数据: [
    'Hadoop', 'Spark', 'Flink', 'Hive', 'Storm', 'Airflow', 'DataX', 'Presto', 'Doris',
  ],
  AI: [
    'PyTorch', 'TensorFlow', 'Transformers', 'LangChain', 'RAG', 'LLM 微调',
    'Stable Diffusion', 'OpenCV', 'scikit-learn', '向量数据库',
  ],
  移动端: ['Android', 'iOS', 'SwiftUI', 'Jetpack Compose', 'HarmonyOS'],
  测试与质量: [
    'JUnit', 'Pytest', 'Selenium', 'Appium', 'JMeter', 'Postman',
    'Playwright', 'Cypress', 'TDD', '性能测试', '自动化测试',
  ],
  方法与架构: [
    '微服务', '分布式系统', '高并发', '高可用', 'DDD', '事件驱动', '服务治理',
    '多活容灾', '性能优化', '可观测性', '敏捷开发', 'Scrum', '技术管理', '团队管理',
  ],
} as const

export type SkillCategory = keyof typeof SKILL_VOCABULARY

/** 扁平化的全部技能名,喂 prompt 与校验模型输出都用它。 */
export const ALL_SKILLS: readonly string[] = Object.values(SKILL_VOCABULARY).flat()

const SKILL_SET = new Set<string>(ALL_SKILLS)

/** 模型返回的技能名是否在词表内。用于把越界项过滤掉 —— 模型偶尔仍会自由发挥,
 *  放行就会让「可比性」这个唯一目的失效。 */
export function isKnownSkill(name: string): boolean {
  return SKILL_SET.has(name)
}
