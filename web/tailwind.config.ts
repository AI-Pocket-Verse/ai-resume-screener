import type { Config } from 'tailwindcss'
// @ts-expect-error -- shared preset is plain CJS, no types needed
import preset from '@ai-resume-screener/tailwind-preset'

/**
 * 【不要在这里加表面 / 文本 / 描边 / 主色】—— 那些全走共享 token
 * (bg-bg、bg-surface、text-fg、text-fg-muted、border-line、bg-accent…),
 * 定义在 packages/design-tokens/skins/*.css。
 *
 * 下面留下的两组是【业务语义色】:
 * 它们是数据含义本身,换皮肤【不该】跟着变,也不该进共享层污染公共命名。
 */
export default {
  presets: [preset],
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    // 必须包含:<UserMenu> 的类名写在这个包里,
    // 不扫描会被 purge 掉 —— 侧栏底部的头像菜单会变成没样式的一堆文字。
    '../packages/auth-client-web/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // 档位色。**业务语义色**:A/B/C/D 是简历筛选独有的评级概念,别的产品用不到;
        // 且「绿=优、红=差」的含义与视觉主题无关,换皮肤不该变。
        // fg 是【压在这些实心色块上的文字色】。业务色本身固定,配套前景当然也固定 ——
        // 不能写 text-white:颜色一律走 token;也不能写 text-bg:那个跟皮肤走,
        // 深色皮肤下会变成深色字压在深绿/深红上。
        grade: {
          a: '#0f9960', 'a-bg': '#e7f6ef',
          b: '#2563eb', 'b-bg': '#eff6ff',
          c: '#c2701c', 'c-bg': '#fdf3e7',
          d: '#6b7280', 'd-bg': '#f3f4f6',
          fg: '#ffffff',
        },
        // 门槛未通过用的红。刻意比常规告警红柔和 —— 门槛失败**不是错误**,
        // 只标红提示,绝不自动淘汰。同属业务语义色,不随皮肤变。
        gate: { fail: '#d1424a', 'fail-bg': '#fdeced', 'fail-fg': '#ffffff' },
      },
    },
  },
} satisfies Config
