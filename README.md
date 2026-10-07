# AICD3 Launchpad

Internship postings from pharma, biotech and startup companies, tracked for AICD3 students: a dashboard, a filterable job board, company info, and a staff-only admin area with a review queue.

## Run it

```bash
pnpm install
pnpm dev        # http://localhost:3000
pnpm build && pnpm start   # production build
```

## Routes

| URL | Page |
| --- | --- |
| `/` | Dashboard |
| `/jobs` | Job board |
| `/companies` | Company info |
| `/admin` | Admin (staff) |
| `/settings` | Settings |

## How it's put together

- **Next.js App Router.** `app/layout.tsx` wraps every route in `components/AppShell.tsx` (sidebar, top bar, ⌘K menu, dialogs). The shell renders only in the browser (`components/ClientRoot.tsx` loads it with `ssr: false`) because it reads saved settings and each person's lists from browser storage on first render.
- **Pages** live in `views/` and are mounted by the matching `app/<route>/page.tsx`.
- **Data** goes through `lib/backend.ts`. With no database connected it runs on the sample postings in `lib/data.ts`, saved in the visitor's browser, and the top bar shows "Sample data". Swap that hook's reads and writes for API calls (for example Prisma on Neon) to share real postings.
- **Styling** is Tailwind CSS v3 with the design tokens in `app/globals.css` and `tailwind.config.js`; UI pieces are shadcn/ui on Radix. Charts use ECharts; the map uses d3-geo with us-atlas.
- **Fonts**: Geist and Geist Mono from the `geist` package, so builds don't need network access to Google Fonts.

## Deploy

Push to GitHub and import the repository in Vercel; the defaults work (framework Next.js, `pnpm build`). Until a database and sign-in are wired up, every visitor gets their own sample data and the Admin area is open to anyone.
