import type { NextConfig } from "next";

// Scripts may only come from this site (plus Next.js's own inline bootstrap). Development also needs
// eval for fast refresh; Vercel's preview toolbar loads from vercel.live.
const dev = process.env.NODE_ENV !== "production"
const scriptSrc = ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : []), "https://vercel.live"].join(" ")

// Headers that keep the app from being framed, sniffed or leaking URLs to other sites.
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: `frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; script-src ${scriptSrc}` },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // the scraper's Python environments are run at runtime, never bundled
  outputFileTracingExcludes: { "*": [".venv/**", ".venv-d3/**", "scraper/**/__pycache__/**"] },
  experimental: {
    // bulk imports from the Admin page send a few hundred postings in one call
    serverActions: { bodySizeLimit: "10mb" },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
