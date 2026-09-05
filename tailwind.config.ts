import type { Config } from "tailwindcss";

/**
 * Identidade visual do app = identidade da página de vendas.
 *
 * A página fala em papel branco, tinta preta, um coral só para o que pede
 * atenção e um verde-água só para o que está "no ar" (online, entrada). A
 * tipografia é a DM Sans em dois pesos, 400 e 500, com entrelinha curta e
 * tracking negativo — e é por isso que `font-bold`, `font-semibold` e
 * `font-extrabold` viram 500 aqui: a hierarquia sai do tamanho e da cor,
 * não do negrito. Trocar nos utilitários, e não tela a tela, garante que
 * nenhum cartão antigo continue gritando em negrito no meio de uma página
 * que fala baixo.
 */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "1rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        sans: ['"DM Sans"', "ui-sans-serif", "system-ui", "sans-serif"],
      },
      fontWeight: {
        semibold: "500",
        bold: "500",
        extrabold: "500",
        black: "500",
      },
      letterSpacing: {
        // Os três trackings da página: rótulo em caixa alta, corpo e título.
        rotulo: "0.08em",
        corpo: "-0.012em",
        titulo: "-0.03em",
        display: "-0.041em",
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        /** O #f7f7f7 da página: fundo de célula dentro de um cartão branco. */
        surface: "hsl(var(--surface))",
        /** O #d9d9d9: borda de campo e de botão de contorno. */
        "line-strong": "hsl(var(--line-strong))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
          hover: "hsl(var(--primary-hover))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        ink: {
          DEFAULT: "hsl(var(--ink))",
          foreground: "hsl(var(--ink-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        /** Raios da página: célula 12, cartão 20, folha 28, pílula 30, moldura 45.
         *  `xl`, `2xl` e `3xl` são remapeados de propósito: os 40 cartões que já
         *  pedem `rounded-2xl` passam a ter o raio do cartão da página. */
        xl: "12px",
        "2xl": "20px",
        "3xl": "28px",
        card: "20px",
        panel: "28px",
        pill: "30px",
        frame: "45px",
      },
      boxShadow: {
        /** A sombra da pílula de navegação e dos cartões de plano. */
        pill: "0 8px 30px rgba(0,0,0,0.12)",
        card: "0 8px 30px rgba(0,0,0,0.06)",
        frame: "0 8px 127px rgba(0,0,0,0.11)",
        sheet: "0 -10px 60px rgba(0,0,0,0.25)",
      },
      transitionTimingFunction: {
        page: "cubic-bezier(0.22, 0.61, 0.36, 1)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "online-pulse": {
          "0%": { boxShadow: "0 0 0 0 rgba(0,166,153,0.55)" },
          "70%": { boxShadow: "0 0 0 9px rgba(0,166,153,0)" },
          "100%": { boxShadow: "0 0 0 0 rgba(0,166,153,0)" },
        },
        "rise-in": {
          from: { opacity: "0", transform: "translateY(14px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "online-pulse": "online-pulse 2s ease-out infinite",
        "rise-in": "rise-in 0.6s cubic-bezier(0.22, 0.61, 0.36, 1) both",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
