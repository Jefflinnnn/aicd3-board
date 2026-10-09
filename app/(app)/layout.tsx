import { ClientRoot } from "@/components/ClientRoot"

/** The signed-in app: sidebar, top bar, dialogs. Sign-in pages under /auth render without it. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <ClientRoot>{children}</ClientRoot>
}
