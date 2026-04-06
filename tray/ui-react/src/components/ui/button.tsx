import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-[12px] font-medium transition-colors cursor-pointer disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'bg-[var(--color-status-blue)] text-white shadow-sm hover:brightness-110 active:brightness-90',
        secondary:
          'bg-[var(--color-surface)] text-[var(--color-foreground)] border border-[var(--color-line)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-foreground-primary)]',
        destructive:
          'bg-[var(--color-status-red-soft)] text-[var(--color-status-red)] border border-[rgba(255,69,58,0.15)]',
        ghost:
          'bg-transparent border border-transparent text-[var(--color-foreground-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-foreground-primary)]',
        attention:
          'bg-[var(--color-status-yellow-soft)] text-[var(--color-status-yellow)] border border-[rgba(255,214,10,0.15)]',
      },
      size: {
        default: 'h-7 px-3',
        sm: 'h-6 px-2 text-[11px]',
        lg: 'h-8 px-4',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  },
)
Button.displayName = 'Button'

export { Button, buttonVariants }
