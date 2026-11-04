// API 客户端。同源访问,所以路径是相对的 —— 开发时 vite proxy 转发到 4070,
// 生产由 nginx 反代。

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** 后端附带的额外字段(如 has_candidates 会带 candidateCount)。 */
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message)
  }
}

const BASE = '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    // 会话是 cookie,跨端口 dev 时必须带上。
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(res.status, body.error ?? 'unknown', body.message ?? `请求失败(${res.status})`, body)
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

const get = <T>(p: string) => request<T>(p)
const post = <T>(p: string, body?: unknown) =>
  request<T>(p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
const put = <T>(p: string, body: unknown) => request<T>(p, { method: 'PUT', body: JSON.stringify(body) })
const del = <T>(p: string) => request<T>(p, { method: 'DELETE' })

// ── 类型(与 api 侧路由返回值对应)────────────────────────────────

export interface Team { id: string; name: string; description: string | null; _count: { jobs: number } }

export interface JobSummary {
  id: string; title: string; status: string; location: string | null; level: string | null
  headcount: number; team: { id: string; name: string }
  hasScorecard: boolean; candidateCount: number; createdAt: string
}

export type Grade = 'A' | 'B' | 'C' | 'D'

export interface CandidateRow {
  applicationId: string
  candidateId: string
  name: string
  currentCompany: string | null
  currentIsPast: boolean
  totalYears: number | null
  parseState: string
  /** 解析时检出疑似操纵评估的内容。**不阻断流程**,只提示人工核对 ——
   *  AI 岗位候选人在项目经历里贴自己写的提示词是完全正常的。 */
  injectionSuspected: boolean
  tags: Array<{ label: string; color: string | null }>
  hrDecision: string | null
  analyzing: string | null
  verdict: {
    grade: Grade | null
    score: number | null
    source: 'screen' | 'deep'
    summary: string | null
    supersededGrade: string | null
  } | null
}

export interface Evidence { quote: string; section: string | null }

export interface EvaluationDetail {
  id: string
  tier: 'screen' | 'deep'
  grade: Grade | null
  weightedScore: number | null
  summary: string | null
  gateResults: Array<{
    key: string; label: string; pass: boolean | 'unknown'
    reason: string | null; evidence: Evidence[]; judgedBy: 'code' | 'llm'
  }>
  scores: Array<{ key: string; score: number; reason: string; evidence: Evidence[] }>
  highlights: Array<{ text: string; evidence: Evidence[] }>
  concerns: Array<{ text: string; evidence: Evidence[] }>
  extras: {
    breakdown?: Array<{ key: string; label: string; score: number; weight: number; contribution: number }>
    followUpQuestions?: Array<{ question: string; rationale: string }>
    verdict?: { stance: string; mainReason: string; mainConcern: string }
    peerContext?: {
      cohortSize: number
      dimensions: Array<{ key: string; label: string; score: number; rank: number; median: number; vsMedian: string }>
    }
  }
  // dimensions 标成【可选】是刻意的:服务端对这一列走的是容错解析(safeParse),
  // 老数据或写坏的行会退化成空壳。声明成必填等于骗编译器,而代价是详情页整页白屏。
  scorecardSnapshot: { gates?: unknown[]; dimensions?: Array<{ key: string; label: string; weight: number }> }
  model: string | null
  latencyMs: number | null
  createdAt: string
}

export interface ResumeFileRow {
  id: string; filename: string; bytes: number; pageCount: number | null
  parseState: string; parseError: string | null; truncated: boolean
  uploadedAt: string; derived: { totalYears: number | null; currentCompany: string | null } | null
}

export interface JobDetail {
  id: string
  title: string
  jdRaw: string
  location: string | null
  level: string | null
  headcount: number
  status: string
  team: Team
  scorecard: (Scorecard & { id: string }) | null
}

export interface Scorecard {
  gates: Array<Record<string, unknown>>
  dimensions: Array<{ key: string; label: string; weight: number; anchors: { '5': string; '3': string; '1': string } }>
}

/** 当前用户在本产品里的权限档位。**只用来隐藏入口,不当防线** ——
 *  每条路由自己都挂了 preHandler,藏起来的按钮被手动 POST 一样 403。 */
export interface Me {
  id: string | null
  openId: string | null
  name: string | null
  /** 超管:能看全部岗位 + 彻底删除 + 审计日志。判定是写死的手机号。 */
  isSuperAdmin: boolean
}

export const api = {
  me: () => get<Me>('/me'),
  users: (q?: string) => get<Array<{ id: string; name: string; email: string | null; avatarUrl: string | null }>>(
    `/users${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  members: (jobId: string) => get<{ canManage: boolean; members: JobMember[] }>(`/jobs/${jobId}/members`),
  addMember: (jobId: string, userId: string) => post<{ ok: true }>(`/jobs/${jobId}/members`, { userId }),
  removeMember: (jobId: string, userId: string) => del<{ ok: true }>(`/jobs/${jobId}/members/${userId}`),
  teams: () => get<Team[]>('/teams'),
  createTeam: (name: string, description?: string) => post<Team>('/teams', { name, description }),

  jobs: (teamId?: string) => get<JobSummary[]>(`/jobs${teamId ? `?teamId=${teamId}` : ''}`),
  job: (id: string) => get<JobDetail>(`/jobs/${id}`),
  updateJob: (id: string, body: Record<string, unknown>) => request<{ id: string }>(`/jobs/${id}`, {
    method: 'PATCH', body: JSON.stringify(body),
  }),
  deleteJob: (id: string, force = false) => del<{ ok: true }>(`/jobs/${id}${force ? '?force=true' : ''}`),
  createJob: (body: { teamId: string; title: string; jdRaw?: string; location?: string; level?: string }) =>
    post<{ id: string }>('/jobs', body),
  draftScorecard: (jobId: string) => post<Scorecard>(`/jobs/${jobId}/scorecard/draft`),
  saveScorecard: (jobId: string, sc: Scorecard) => put<{ id: string }>(`/jobs/${jobId}/scorecard`, sc),
  copyScorecard: (jobId: string, fromJobId: string) =>
    post<{ id: string }>(`/jobs/${jobId}/scorecard/copy-from/${fromJobId}`),

  candidates: (jobId: string) => get<CandidateRow[]>(`/jobs/${jobId}/candidates`),
  candidate: (id: string) => get<CandidateDetail>(`/candidates/${id}`),
  evaluation: (id: string) => get<EvaluationDetail>(`/evaluations/${id}`),
  analyze: (applicationIds: string[], tier: 'screen' | 'deep') =>
    post<{ queued: number }>('/evaluations', { applicationIds, tier }),
  decide: (applicationId: string, decision: 'pass' | 'reject' | 'hold' | null, reason?: string) =>
    put<unknown>(`/applications/${applicationId}/decision`, { decision, reason }),
  apply: (candidateId: string, jobId: string) => post<{ id: string }>('/applications', { candidateId, jobId }),

  files: (parseState?: string) => get<ResumeFileRow[]>(`/files${parseState ? `?parseState=${parseState}` : ''}`),
  upload: (jobId: string, file: File) => {
    const fd = new FormData()
    // jobId 必须先 append —— multipart 是流式解析的,字段排在文件后面时
    // 服务端读到文件那一刻还看不到它。
    fd.append('jobId', jobId)
    fd.append('file', file)
    return request<{ id: string; filename: string; parseState: string }>('/files', { method: 'POST', body: fd })
  },
  paste: (jobId: string, text: string, filename?: string) =>
    post<{ id: string }>('/files/paste', { jobId, text, filename }),
  reparse: (id: string) => post<{ queued: boolean }>(`/files/${id}/reparse`),

  addTag: (candidateId: string, jobId: string, label: string) =>
    post<{ id: string }>(`/candidates/${candidateId}/tags`, { jobId, label }),
  removeTag: (tagId: string) => del<unknown>(`/tags/${tagId}`),
  tagSuggestions: (q: string) => get<Array<{ label: string; count: number }>>(`/tags?q=${encodeURIComponent(q)}`),

  mergeCandidate: (id: string, intoId: string) => post<unknown>(`/candidates/${id}/merge`, { intoId }),
  undoMerge: (id: string) => post<unknown>(`/candidates/${id}/undo-merge`),
  dismissHint: (id: string) => post<unknown>(`/duplicate-hints/${id}/dismiss`),
  deleteCandidate: (id: string) => del<{ filesDeleted: number; note: string }>(`/candidates/${id}`),
  bulkDeleteCandidates: (ids: string[]) =>
    post<{ deleted: number; filesDeleted: number; bytesFreed: number; note: string }>('/candidates/bulk-delete', { ids }),
}

export interface JobMember {
  userId: string
  name: string
  email: string | null
  avatarUrl: string | null
  role: string
}

export interface CandidateDetail {
  id: string
  name: string | null
  wasRedirected: boolean
  mergedCount: number
  aliases: string[]
  identifiers: Array<{ kind: string; value: string; isPrimary: boolean }>
    tags: Array<{ id: string; label: string; color: string | null }>
  files: Array<{
    id: string; filename: string; parseState: string; uploadedAt: string; pageCount: number | null
    // derived 单独可空:服务端是 safeParse(..., null),整份 parsed 在、单独 derived
    // 坏掉是可能的。目前没有组件读它,标对是为了下一个来读的人不会踩空。
    parsed: { data: ResumeData; derived: Derived | null } | null
  }>
  applications: Array<{
    id: string
    job: { id: string; title: string }
    hrDecision: string | null
    evaluations: Array<{ id: string; tier: string; grade: string | null; weightedScore: number | null; createdAt: string }>
  }>
  duplicateHints: Array<{ id: string; otherId: string; otherName: string | null; matchedField: string }>
}

export interface Derived {
  totalYears: number | null
  totalYearsEstimated: boolean
  jobHopCount: number
  avgTenureMonths: number | null
  maxGapMonths: number | null
  currentCompany: string | null
  currentTitle: string | null
  currentIsPast: boolean
  timelineConflicts: string[]
}

export interface ResumeData {
  basic: {
    name: string | null; phone: string | null; email: string | null; city: string | null
    expectedTitle: string | null; expectedSalary: string | null; summary: string | null
  }
  education: Array<{ school: string; major: string | null; degree: string | null; start: string | null; end: string | null }>
  work: Array<{
    company: string; title: string | null; start: string | null; end: string | null
    responsibilities: string[]; achievements: string[]
  }>
  project: Array<{ name: string; role: string | null; workIndex: number | null; techStack: string[]; description: string | null }>
  skill: Array<{ name: string; level: string | null }>
  cert: Array<{ name: string; issuedAt: string | null }>
  injectionSuspected: boolean
  injectionEvidence: string | null
}
