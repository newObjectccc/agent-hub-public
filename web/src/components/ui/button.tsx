import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// 源出 neobrutalism.com registry（shadcn CLI）；按需定制为原生 <button> 实现，
// 去除 @base-ui/react 原语层（copy-paste 归项目，无运行时依赖锁定）。
const buttonVariants = cva(
  cn(
    "group/button font-head font-bold inline-flex cursor-pointer items-center justify-center gap-2 rounded whitespace-nowrap select-none transition-all duration-200",
    "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-60",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary aria-invalid:border-destructive",
    // Icons keep their own size; we only set a default when none is given so
    // Neobrutalism's h-4/size-4 icons aren't overridden.
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
  ),
  {
    variants: {
      variant: {
        default:
          "border-2 border-border bg-primary text-primary-foreground shadow-md transition duration-200 hover:-translate-x-0.5 hover:-translate-y-0.5 hover:bg-primary-hover hover:shadow-lg active:translate-x-1 active:translate-y-1 active:shadow-none",
        secondary:
          "border-2 border-border bg-secondary text-secondary-foreground shadow-md transition duration-200 hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-lg active:translate-x-1 active:translate-y-1 active:shadow-none",
        destructive:
          "border-2 border-border bg-destructive text-destructive-foreground shadow-md transition duration-200 hover:-translate-x-0.5 hover:-translate-y-0.5 hover:bg-destructive/90 hover:shadow-lg active:translate-x-1 active:translate-y-1 active:shadow-none",
        outline:
          "border-2 border-border bg-transparent shadow-md transition duration-200 hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-lg active:translate-x-1 active:translate-y-1 active:shadow-none",
        ghost: "bg-transparent hover:bg-accent",
        link: "bg-transparent hover:underline",
      },
      size: {
        default: "px-3 py-1.5 text-base min-h-[44px]",
        xs: "px-1.5 py-0.5 text-xs",
        sm: "px-2.5 py-1 text-sm min-h-[40px]",
        lg: "px-5 py-2 text-base lg:px-7 lg:py-2.5 lg:text-lg",
        icon: "p-1.5",
        "icon-xs": "p-1",
        "icon-sm": "p-1",
        "icon-lg": "p-2",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return (
    <button
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
