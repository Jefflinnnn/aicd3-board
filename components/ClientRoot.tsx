"use client"

import dynamic from "next/dynamic"

/**
 * The app runs entirely in the browser: it reads saved settings and the viewer's lists from browser
 * storage on its first render, so it isn't prerendered on the server. Each route still gets its own URL
 * and code-split bundle.
 */
const AppShell = dynamic(() => import("@/components/AppShell"), {
  ssr: false,
  loading: () => <div className="h-full bg-background" />,
})

export function ClientRoot({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>
}
