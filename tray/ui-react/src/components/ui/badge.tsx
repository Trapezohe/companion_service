import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border',
  {
    variants: {
      variant: {
        healthy:
          'text-[var(--color-status-green)] bg-[var(--color-status-green-soft)] border-[rgba(50,215,75,0.2)]',
        warning:
          'text-[var(--color-status-yellow)] bg-[var(--color-status-yellow-soft)] border-[rgba(255,159,10,0.2)]',
        error:
          'text-[var(--color-status-red)] bg-[var(--color-status-red-soft)] border-[rgba(255,69,58,0.2)]',
        info:
          'text-[var(--color-status-blue)] bg-[var(--color-status-blue-soft)] border-[rgba(10,132,255,0.2)]',
        muted:
          'text-[var(--color-foreground-muted)] bg-[var(--color-surface)] border-[var(--color-line)]',
      },
    },
    defaultVariants: {
      variant: 'muted',
    },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
