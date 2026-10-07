import type { Metadata, Viewport } from "next";
// Geist ships with the app (the `geist` package wraps next/font/local), so builds don't need to reach Google Fonts.
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { ClientRoot } from "@/components/ClientRoot";
import "./globals.css";

export const metadata: Metadata = {
  title: "AICD3 Launchpad",
  description: "Internship postings from pharma, biotech and startup companies, tracked for AICD3 students.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf9f5" },
    { media: "(prefers-color-scheme: dark)", color: "#262624" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <body>
        <ClientRoot>{children}</ClientRoot>
      </body>
    </html>
  );
}
