import { cn } from '@/lib/cn'
import { useI18n } from '@/i18n'
import type { Grade } from '@/lib/api'

const STYLE: Record<Grade, string> = {
  A: 'bg-grade-a-bg text-grade-a',
  B: 'bg-grade-b-bg text-grade-b',
  C: 'bg-grade-c-bg text-grade-c',
  D: 'bg-grade-d-bg text-grade-d',
}

/**
 * 档位徽标。**视觉上必须明显强于总分**——
 * 档位是大号徽标,总分是小字灰色。让 HR 先看到「B 档」这个粗粒度判断,
 * 而不是盯着 82 和 79 的差别做决定,那个差别本身没有那么高的置信度。
 */
export function GradeBadge({ grade, size = 'md' }: { grade: Grade | null; size?: 'sm' | 'md' }) {
  if (!grade) return null
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-lg font-semibold tabular-nums',
        STYLE[grade],
        size === 'md' ? 'h-8 w-8 text-lg' : 'h-6 w-6 text-sm',
      )}
    >
      {grade}
    </span>
  )
}

/** 总分。**取整到个位、小字、灰色** —— 绝不出现 87.3 那种伪精度。 */
export function ScoreText({ score, className }: { score: number | null; className?: string }) {
  const { t } = useI18n()
  if (score == null) return null
  return <span className={cn('text-xs tabular-nums text-fg-faint', className)}>{t('common.score', { n: Math.round(score) })}</span>
}

/** 维度得分条。按分数配色,与档位色系一致(5/4 好、3 中、2/1 差)。 */
export function ScoreBar({ score }: { score: number }) {
  const color =
    score >= 5 ? 'bg-grade-a' : score >= 4 ? 'bg-grade-b' : score >= 3 ? 'bg-grade-d' : 'bg-grade-c'
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface">
      <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${(score / 5) * 100}%` }} />
    </div>
  )
}
