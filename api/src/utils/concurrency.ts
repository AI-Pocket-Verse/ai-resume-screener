/** 计数信号量。只有 acquire —— 本产品没有 per-conversation 串行化的需求。 */
export class Semaphore {
  private inFlight = 0
  private waiters: Array<() => void> = []

  constructor(private readonly capacity: number) {}

  acquire(timeoutMs?: number): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const tryGrant = (): boolean => {
        if (this.inFlight < this.capacity) {
          this.inFlight++
          let released = false
          resolve(() => {
            if (released) return
            released = true
            this.inFlight--
            const next = this.waiters.shift()
            if (next) next()
          })
          return true
        }
        return false
      }
      if (tryGrant()) return
      let timer: NodeJS.Timeout | null = null
      const waiter = () => {
        // 若被别的等待者抢先拿到槽位,重新排队 —— 否则会静默掉队,
        // 一直饿到 acquire 超时。
        if (!tryGrant()) {
          this.waiters.push(waiter)
          return
        }
        if (timer) clearTimeout(timer)
      }
      this.waiters.push(waiter)
      if (timeoutMs != null) {
        timer = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter)
          reject(new Error('semaphore acquire timeout'))
        }, timeoutMs)
      }
    })
  }
}

/**
 * 渲染闸:CPU 密集(poppler 光栅化)。
 *
 * **必须与 LLM 的闸分开**:一个吃 CPU、一个吃网络/子进程等待。合用一个闸时,
 * 几份简历在渲染阶段占满槽位,会把只是在等模型回话的任务一并堵死,反之亦然。
 */
export const renderSemaphore = new Semaphore(2)

/**
 * LLM 闸。CLI 类 provider 每次调用 spawn 一个 claude 子进程,吃内存也吃登录态配额,
 * 所以给得比 API 类保守。接入 API provider 后应按 provider 类型分别给闸
 * (CLI 3 / API 15),而不是抬高这一个。
 */
export const llmSemaphore = new Semaphore(3)
