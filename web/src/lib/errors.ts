// 后端错误码 → 界面文案。未知码回落到后端给的 message。
import type { MessageKey, TFunction } from '@/i18n'
import { ApiError } from './api'

/** 有固定文案的错误码。forbidden 有两种文案,单独处理。 */
const CODE_KEYS: Record<string, MessageKey> = {
  duplicate_name: 'error.duplicate_name',
  user_not_found: 'error.user_not_found',
  empty_jd: 'error.empty_jd',
  draft_failed: 'error.draft_failed',
  bad_weight: 'error.bad_weight',
  deep_is_single_only: 'error.deep_is_single_only',
  missing_job: 'error.missing_job',
  last_owner: 'error.last_owner',
  has_candidates: 'error.has_candidates',
  empty_file: 'error.empty_file',
  payload_too_large: 'error.payload_too_large',
  unsupported_media_type: 'error.unsupported_media_type',
}

/**
 * 接口错误 → 展示文案。
 * ApiError 按 code 映射;未知 code 用后端 message,后端也没给就用「请求失败(状态码)」。
 * 非 ApiError(网络断开等)用调用处给的 fallback。
 */
export function errorMessage(e: unknown, t: TFunction, fallback: MessageKey = 'error.actionFailed'): string {
  if (!(e instanceof ApiError)) return t(fallback)
  const backend = typeof e.extra?.message === 'string' ? e.extra.message : ''
  if (e.code === 'forbidden') {
    // 两种 403 文案靠后端 message 区分(同一个 code)
    if (backend.includes('超级管理员')) return t('error.forbidden.admin')
    if (backend.includes('创建者')) return t('error.forbidden.owner')
  } else if (e.code === 'unsupported_media_type' && backend.includes('不匹配')) {
    // 同一个 code 两种文案(api/src/services/file-store.ts):类型不支持 / 内容与扩展名不符
    return t('error.type_mismatch')
  } else if (e.code === 'bad_weight') {
    const sum = backend.match(/(\d+)\s*$/)?.[1]
    if (sum) return t('error.bad_weight', { sum })
  } else if (e.code === 'has_candidates') {
    return t('error.has_candidates', { n: Number(e.extra?.candidateCount ?? 0) })
  } else if (CODE_KEYS[e.code]) {
    return t(CODE_KEYS[e.code]!)
  }
  return backend || t('error.http', { status: e.status })
}

