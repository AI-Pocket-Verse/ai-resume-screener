import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { env } from '../env.js'
import { renderPdf } from './render.js'

// 用 shell 桩替代 poppler(本机不一定装了):
//  - pdfinfo 报 2 页
//  - pdftocairo 每页休眠 0.4 秒后写 png;输出目录不存在时和真实工具一样报错退出 1
// 走真实的 renderPdf / renderSemaphore,只替换外部程序。
let bin = ''
const origPath = process.env.PATH
let pdf = ''

beforeAll(async () => {
  bin = await mkdtemp(path.join(tmpdir(), 'poppler-stub-'))
  await writeFile(path.join(bin, 'pdfinfo'), `#!/bin/sh\necho "Pages:          2"\necho "Page size:      595 x 842 pts (A4)"\necho "Encrypted:       no"\n`)
  await writeFile(
    path.join(bin, 'pdftocairo'),
    `#!/bin/sh
prefix="$(eval echo \\\${$#})"
dir="$(dirname "$prefix")"
[ -d "$dir" ] || { echo "I/O Error: Couldn't open file" >&2; exit 1; }
for i in 1 2; do sleep 0.4; [ -d "$dir" ] || { echo "I/O Error" >&2; exit 1; }; echo png > "$prefix-$i.png"; done
`,
  )
  await chmod(path.join(bin, 'pdfinfo'), 0o755)
  await chmod(path.join(bin, 'pdftocairo'), 0o755)
  process.env.PATH = `${bin}:${origPath}`
  pdf = path.join(bin, 'a.pdf')
  await writeFile(pdf, '%PDF-1.4\n')
  await mkdir(env.DATA_DIR, { recursive: true })
})

afterAll(async () => {
  process.env.PATH = origPath
  await rm(bin, { recursive: true, force: true })
  await rm(path.join(env.DATA_DIR, 'resume-pages'), { recursive: true, force: true })
})

describe('renderPdf 并发', () => {
  // 回归:相同 sha256 的两个任务,后到者(此时先到者已写出第 1 页)曾 rm 掉渲染目录,
  // 导致先到者 render_incomplete、后到者 pdf_corrupt(永久失败)。
  it('同一 sha 错开进入:两者都成功,拿到同样的 2 页,且后到者不重渲', async () => {
    const sha = 'sha-race-offset'
    const a = renderPdf(pdf, sha)
    await new Promise((r) => setTimeout(r, 500)) // A 已写出第 1 页
    const b = renderPdf(pdf, sha)
    const [ra, rb] = await Promise.all([a, b])
    expect(ra.pagePaths).toHaveLength(2)
    expect(rb.pagePaths).toEqual(ra.pagePaths)
    expect(await readdir(path.join(env.DATA_DIR, 'resume-pages', sha))).toHaveLength(2)
  })

  it('同一 sha 同时进入:两者都成功', async () => {
    const sha = 'sha-race-simul'
    const [ra, rb] = await Promise.all([renderPdf(pdf, sha), renderPdf(pdf, sha)])
    expect(ra.pagePaths).toHaveLength(2)
    expect(rb.pagePaths).toEqual(ra.pagePaths)
  })

  it('不同 sha 互不阻塞', async () => {
    const t0 = Date.now()
    const [ra, rb] = await Promise.all([renderPdf(pdf, 'sha-x'), renderPdf(pdf, 'sha-y')])
    expect(ra.pagePaths).toHaveLength(2)
    expect(rb.pagePaths).toHaveLength(2)
    expect(Date.now() - t0).toBeLessThan(1800) // 串行至少 1.6s+,并行约 0.8s
  })
})
