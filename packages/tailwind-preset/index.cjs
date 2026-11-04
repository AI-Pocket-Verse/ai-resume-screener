/**
 * 共享 Tailwind preset —— token 到类名的【唯一映射点】。
 *
 * 每个 web app 只需:
 *   presets: [require('@ai-resume-screener/tailwind-preset')]
 * 并且【不再自带 colors】。
 *
 * ⚠️ 颜色一律映射成 `rgb(var(--x) / <alpha-value>)` 而非 `var(--x)`。
 *    Tailwind 的 <alpha-value> 占位符要求【通道值】,写成完整色值会让 bg-accent/90
 *    这类透明度修饰符【静默失效】—— 不报错,但透明度不生效。
 *
 * 色值本身不在这里,在 @ai-resume-screener/design-tokens 的 structure.css + skins/*.css。
 * 改颜色永远只改那一个包。
 */

/**
 * 每个 token 都带一个 fallback(LEGACY):CSS 变量只有引入了 design-tokens 的
 * structure.css + skins/*.css 才有定义;没引入时 `var(--radius-lg)` 是悬空引用,
 * 浏览器会把整条声明直接丢弃(圆角变直角、阴影消失),Tailwind 也不会报错。
 * fallback 保证没引入 token 的页面仍有一套可用的默认视觉。
 */
const LEGACY = {
  // 表面/文本/描边:旧 preset 是深色系(design-tokens/tailwind.cjs)
  bg: '11 13 18', // #0b0d12
  surface: '20 24 33', // #141821
  panel: '20 24 33', // 旧版无此 token,取最接近的 surface
  elevated: '20 24 33', // 同上
  fg: '230 233 239', // #e6e9ef
  'fg-muted': '154 163 178', // #9aa3b2(旧 muted)
  'fg-faint': '154 163 178', // 同上
  line: '37 43 56', // #252b38
  'line-strong': '37 43 56', // 旧版无此 token
  accent: '167 139 250', // #a78bfa
  'accent-fg': '26 18 38', // #1a1226(旧 accent.foreground)
  // 给 0 0 0 是为了让未引入 token 的页面用上 bg-overlay 时仍是深色遮罩,不会翻浅。
  overlay: '0 0 0',
  // 导航:旧版无这三个 token,取最接近的旧值
  'nav-active-bg': '20 24 33',
  'nav-active-fg': '230 233 239',
  'nav-group': '154 163 178',
  // 语义:旧版是【单色】,没有 bg/fg/line 三梯度,三档都回落到那一个色
  'success-bg': '16 185 129',
  'success-fg': '16 185 129',
  'success-line': '16 185 129',
  'warning-bg': '245 158 11',
  'warning-fg': '245 158 11',
  'warning-line': '245 158 11',
  'danger-bg': '239 68 68',
  'danger-fg': '239 68 68',
  'danger-line': '239 68 68',
  'info-bg': '59 130 246',
  'info-fg': '59 130 246',
  'info-line': '59 130 246',
}

/** token 名 → Tailwind 颜色值。集中一处,避免 27 个 token 各写一遍模板字符串。 */
const c = (token) => `rgb(var(--${token}, ${LEGACY[token]}) / <alpha-value>)`

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [],
  theme: {
    extend: {
      colors: {
        // ── 表面 ──
        bg: c('bg'),
        surface: c('surface'),
        panel: c('panel'),
        elevated: c('elevated'),
        // 弹窗遮罩。透明度在调用处给:bg-overlay/30
        overlay: c('overlay'),

        // ── 文本 ──  text-fg / text-fg-muted / text-fg-faint
        fg: {
          DEFAULT: c('fg'),
          muted: c('fg-muted'),
          faint: c('fg-faint'),
        },

        // ── 描边 ──  border-line / border-line-strong
        line: {
          DEFAULT: c('line'),
          strong: c('line-strong'),
        },

        // ── 交互 ──  bg-accent / text-accent-fg
        // 悬浮态与焦点环【不单开 token】,用透明度导出:hover:bg-accent/90、ring-accent/15
        accent: {
          DEFAULT: c('accent'),
          fg: c('accent-fg'),
        },

        // ── 导航 ──
        'nav-active-bg': c('nav-active-bg'),
        'nav-active-fg': c('nav-active-fg'),
        'nav-group': c('nav-group'),

        // ── 语义三梯度 ──  bg-danger-bg / text-danger-fg / border-danger-line
        // 用来替代硬编码色,对应调色板的 50 / 700 / 200 三档用法
        success: { bg: c('success-bg'), fg: c('success-fg'), line: c('success-line') },
        warning: { bg: c('warning-bg'), fg: c('warning-fg'), line: c('warning-line') },
        danger: { bg: c('danger-bg'), fg: c('danger-fg'), line: c('danger-line') },
        info: { bg: c('info-bg'), fg: c('info-fg'), line: c('info-line') },
      },

      // 圆角 4 档。用 extend 合并,Tailwind 自带的 full / 3xl 仍可用
      //(rounded-full 很常用,不能弄丢)。
      //
      // DEFAULT 与 2xl 【必须显式列出】:旧 preset 定义过它们(0.5rem / 1.5rem),
      // 不列的话会掉回 Tailwind 默认(0.25rem / 1rem),未引入 token 时圆角会变小。
      borderRadius: {
        DEFAULT: 'var(--radius-md, 0.5rem)',
        sm: 'var(--radius-sm, 0.25rem)',
        md: 'var(--radius-md, 0.5rem)',
        lg: 'var(--radius-lg, 0.75rem)',
        xl: 'var(--radius-xl, 1rem)',
        '2xl': 'var(--radius-xl, 1.5rem)',
      },

      // 阴影 4 档,颜色走皮肤层的 --shadow-color(深色皮肤只改那一个 token)。
      // 刻意【不定义 xl/2xl】—— 用 shadow-lg 代替,否则它们会保留 Tailwind 写死的颜色,
      // 不跟随皮肤。
      //
      // fallback = Tailwind 自带的同名阴影(旧 preset 只覆盖了 glass,sm/md/lg 用的就是它们)。
      // var() 的 fallback 是「第一个逗号之后的全部内容」,所以多段阴影可以整段当 fallback。
      boxShadow: {
        none: 'var(--shadow-none, 0 0 #0000)',
        sm: 'var(--shadow-sm, 0 1px 2px 0 rgb(0 0 0 / 0.05))',
        md: 'var(--shadow-md, 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1))',
        lg: 'var(--shadow-lg, 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1))',
      },

      // 字体【家族】共享;字体【大小】不定义,直接用 Tailwind 默认的 text-xs…text-2xl。
      // 重定义字号会静默改掉所有现有写法。
      fontFamily: {
        // 飞书云文档同款栈:拉丁走系统字体,中文走 PingFang SC,末尾接 emoji
        sans: [
          '-apple-system', 'BlinkMacSystemFont', 'Helvetica Neue', 'Tahoma',
          'PingFang SC', 'Microsoft Yahei', 'Arial', 'Hiragino Sans GB', 'sans-serif',
          'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji',
        ],
        // 命令、路径、URL 一律等宽
        mono: ['ui-monospace', 'SFMono-Regular', 'SF Mono', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
}
