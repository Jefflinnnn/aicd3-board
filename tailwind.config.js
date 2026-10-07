/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./views/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // Geist and Geist Mono come from next/font (see app/layout.tsx), exposed as CSS variables
        sans: ["var(--font-geist-sans)", "system-ui", "-apple-system", "'Segoe UI'", "sans-serif"],
        // headings use the same sans as the UI, set tighter (the dev-tool look of Linear, Vercel, Baseten)
        display: ["var(--font-geist-sans)", "system-ui", "-apple-system", "'Segoe UI'", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        good: "hsl(var(--good) / <alpha-value>)",
        warn: { DEFAULT: "hsl(var(--warn) / <alpha-value>)", soft: "hsl(var(--warn-soft) / <alpha-value>)" },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar) / <alpha-value>)",
          fg: "hsl(var(--sidebar-fg) / <alpha-value>)",
          muted: "hsl(var(--sidebar-muted) / <alpha-value>)",
          hover: "hsl(var(--sidebar-hover) / <alpha-value>)",
          active: "hsl(var(--sidebar-active) / <alpha-value>)",
          accent: "hsl(var(--sidebar-accent) / <alpha-value>)",
          strong: "hsl(var(--sidebar-strong) / <alpha-value>)",
          line: "hsl(var(--sidebar-line) / <alpha-value>)",
        },
        border: "hsl(var(--border) / <alpha-value>)",
        input: "hsl(var(--input) / <alpha-value>)",
        ring: "hsl(var(--ring) / <alpha-value>)",
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        primary: {
          DEFAULT: "hsl(var(--primary) / <alpha-value>)",
          foreground: "hsl(var(--primary-foreground) / <alpha-value>)",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary) / <alpha-value>)",
          foreground: "hsl(var(--secondary-foreground) / <alpha-value>)",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted) / <alpha-value>)",
          foreground: "hsl(var(--muted-foreground) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "hsl(var(--accent) / <alpha-value>)",
          foreground: "hsl(var(--accent-foreground) / <alpha-value>)",
        },
        popover: {
          DEFAULT: "hsl(var(--popover) / <alpha-value>)",
          foreground: "hsl(var(--popover-foreground) / <alpha-value>)",
        },
        card: {
          DEFAULT: "hsl(var(--card) / <alpha-value>)",
          foreground: "hsl(var(--card-foreground) / <alpha-value>)",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
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
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}
