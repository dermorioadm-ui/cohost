import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * O botão da identidade: pílula, 16px, tracking fechado, um leve
 * `scale(0.985)` no toque — e nunca um bloco colorido de canto duro. Sobre o
 * preto do painel, o principal é a pílula branca do herói da página; o neutro
 * é a pílula contornada; o secundário é vidro. O coral não vira botão: é
 * marca, título e preço. Recusa e atenção são laranja, e só no contorno.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium tracking-corpo transition-[background-color,color,border-color,transform,box-shadow] duration-200 ease-page focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-[0.985] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-ink text-ink-foreground hover:bg-[#f0f0f0]",
        ink: "bg-ink text-ink-foreground hover:bg-[#f0f0f0]",
        coral: "bg-primary text-primary-foreground hover:bg-primary-hover",
        destructive: "border border-destructive bg-transparent text-destructive hover:bg-destructive/10",
        outline:
          "border border-line-strong bg-transparent text-foreground hover:border-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-accent",
        ghost: "hover:bg-secondary hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-5 text-[15px]",
        sm: "h-9 px-4 text-[13px]",
        lg: "h-14 px-6 text-base",
        icon: "h-11 w-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
