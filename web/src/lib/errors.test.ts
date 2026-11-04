import { describe, expect, it } from 'vitest'

import { translator } from '@/i18n'
import { ApiError } from './api'
import { errorMessage } from './errors'

const zh = translator('zh')
const en = translator('en')

describe('errorMessage', () => {
  it('已知 code 按语言映射;中文与后端原文一致', () => {
    const e = new ApiError(400, 'empty_jd', '请先填写 JD 原文', { message: '请先填写 JD 原文' })
    expect(errorMessage(e, zh)).toBe('请先填写 JD 原文')
    expect(errorMessage(e, en)).toBe('Please enter the job description first')
  })
  it('上传失败:中文与后端 file-store 原文一致,类型不符单独文案', () => {
    const mk = (code: string, msg: string) => new ApiError(400, code, msg, { message: msg })
    for (const [code, msg] of [['empty_file', '空文件'], ['payload_too_large', '文件超过 20MB 上限'], ['unsupported_media_type', '仅支持 PDF / 图片 / docx'], ['unsupported_media_type', '文件类型与扩展名不匹配']] as const) {
      expect(errorMessage(mk(code, msg), zh)).toBe(msg)
      expect(errorMessage(mk(code, msg), en)).not.toMatch(/[一-龥]/)
    }
    expect(errorMessage(mk('unsupported_media_type', '文件类型与扩展名不匹配'), en)).toBe('The file content does not match its extension')
  })
  it('forbidden 按后端 message 区分两种文案', () => {
    const admin = new ApiError(403, 'forbidden', 'x', { message: '需要超级管理员权限' })
    const owner = new ApiError(403, 'forbidden', 'x', { message: '只有岗位创建者可以管理成员' })
    expect(errorMessage(admin, en)).toBe('Super admin permission required')
    expect(errorMessage(owner, en)).toBe('Only the job owner can manage members')
  })
  it('带变量的 code:权重合计从后端 message 取', () => {
    const e = new ApiError(400, 'bad_weight', 'x', { message: '各维度权重之和须为 100,当前为 90' })
    expect(errorMessage(e, zh)).toBe('各维度权重之和须为 100,当前为 90')
    expect(errorMessage(e, en)).toBe('Dimension weights must add up to 100 (currently 90)')
  })
  it('未知 code 回落到后端 message;没有 message 时用状态码', () => {
    expect(errorMessage(new ApiError(500, 'weird', 'x', { message: 'backend says' }), en)).toBe('backend says')
    expect(errorMessage(new ApiError(404, 'not_found', 'x', {}), en)).toBe('Request failed (404)')
    expect(errorMessage(new ApiError(404, 'not_found', 'x', {}), zh)).toBe('请求失败(404)')
  })
  it('非 ApiError 用调用处的兜底文案', () => {
    expect(errorMessage(new Error('network'), zh, 'error.deleteFailed')).toBe('删除失败')
    expect(errorMessage('x', en)).toBe('Action failed. Please try again.')
  })
})

