import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * O campo do formulário da página: 52px de altura, raio 14, fio #d9d9d9 que
 * vira preto no foco. Sem anel de foco colorido — a borda escurecendo é o
 * sinal, como na página.
 */
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-12 w-full rounded-[14px] border border-input bg-background px-4 py-2 text-base text-foreground tracking-corpo transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-[#b5b5b5] focus-visible:border-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
