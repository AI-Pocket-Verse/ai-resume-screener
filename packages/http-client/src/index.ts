import { ApiError } from '@ai-resume-screener/shared-types'
import type { ZodSchema } from 'zod'

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export interface RequestOptions extends RequestInit {
  query?: Record<string, string | number | boolean | undefined>
  parseAs?: 'json' | 'text' | 'blob' | 'none'
  schema?: ZodSchema
}

export interface HttpClientConfig {
  baseUrl: string
  /** Default headers merged into every request */
  headers?: Record<string, string>
  /** Hook to inject auth token (called per-request) */
  getToken?: () => Promise<string | null> | string | null
  /** Called when server returns 401 — typically triggers re-login */
  onUnauthorized?: () => void
}

export function createHttpClient(config: HttpClientConfig) {
  async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const { query, parseAs = 'json', schema, headers, ...init } = opts
    const url = new URL(path, config.baseUrl)
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v))
      }
    }

    const finalHeaders: Record<string, string> = { ...config.headers, ...(headers as Record<string, string>) }
    const token = await config.getToken?.()
    if (token) finalHeaders.Authorization = `Bearer ${token}`
    if (init.body && !(init.body instanceof FormData) && !finalHeaders['Content-Type']) {
      finalHeaders['Content-Type'] = 'application/json'
    }

    const res = await fetch(url, { credentials: 'include', ...init, headers: finalHeaders })

    if (res.status === 401) config.onUnauthorized?.()

    if (!res.ok) {
      let payload: unknown = await res.text().catch(() => '')
      try {
        payload = JSON.parse(payload as string)
      } catch {}
      const parsed = ApiError.safeParse(payload)
      if (parsed.success) {
        throw new HttpError(res.status, parsed.data.code, parsed.data.message, parsed.data.details)
      }
      throw new HttpError(res.status, 'http_error', `HTTP ${res.status}`, payload)
    }

    if (parseAs === 'none') return undefined as T
    if (parseAs === 'text') return (await res.text()) as T
    if (parseAs === 'blob') return (await res.blob()) as T
    const json = await res.json()
    if (schema) return schema.parse(json) as T
    return json as T
  }

  // If positional body is undefined, fall back to opts.body (lets callers pass
  // FormData/Blob via opts). Otherwise: pass binary-ish bodies through as-is
  // and JSON.stringify the rest.
  const encodeBody = (body: unknown, opts?: RequestOptions): BodyInit | undefined => {
    if (body === undefined) return opts?.body as BodyInit | undefined
    if (
      body instanceof FormData ||
      body instanceof Blob ||
      body instanceof URLSearchParams ||
      body instanceof ArrayBuffer ||
      typeof body === 'string'
    ) {
      return body as BodyInit
    }
    return JSON.stringify(body)
  }

  return {
    request,
    get: <T = unknown>(path: string, opts?: RequestOptions) =>
      request<T>(path, { ...opts, method: 'GET' }),
    post: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) =>
      request<T>(path, { ...opts, method: 'POST', body: encodeBody(body, opts) }),
    put: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) =>
      request<T>(path, { ...opts, method: 'PUT', body: encodeBody(body, opts) }),
    patch: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) =>
      request<T>(path, { ...opts, method: 'PATCH', body: encodeBody(body, opts) }),
    delete: <T = unknown>(path: string, opts?: RequestOptions) =>
      request<T>(path, { ...opts, method: 'DELETE' }),
  }
}

export type HttpClient = ReturnType<typeof createHttpClient>
