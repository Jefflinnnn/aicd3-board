# AICD3 Launchpad

Internship postings from pharma, biotech and startup companies, tracked for AICD3 students: a dashboard, a filterable job board, company info, and a staff-only admin area with a review queue.

- **Sign-in:** UCSF email (`@ucsf.edu`) and password, through Neon Auth. A new account confirms its address once with an emailed code; "Forgot your password, or never set one?" and "Email me a sign-in code instead" also use codes. No other addresses and no Google sign-in. New accounts wait for staff approval unless they were invited or you turn on auto-approval.
- **Data:** Postgres on Neon through Prisma. All of it is read and written by this app's server code, which checks the person's role on every call.
- **Postings:** the scraper in `scraper/` collects them. Claude Code summarizes them with the `/scrape-internships` skill, and new ones go into the staff review queue.

## First-time setup

You need Node 20.19+ (or 22.12+), pnpm, and Python 3.10+ for the scraper.

```bash
# 1. Neon CLI, signed in to your Neon account (opens a browser)
npm i -g neon@latest && neon login

# 2. Neon's skills and MCP server for Claude Code (optional, handy)
neon skills -y
neon mcp -y

# 3. Point this folder at the project's production branch
neon link --project-id dry-firefly-36679733 --branch production -y

# 4. neon.ts is already here (auth: true); this only checks the config packages
neon config init --no-install
pnpm install

# 5. Turn on Neon Auth and write DATABASE_URL, DATABASE_URL_UNPOOLED and NEON_AUTH_BASE_URL to .env.local
neon deploy
```

Then add these lines to `.env.local` yourself. It's git-ignored; never commit it.

```bash
NEON_AUTH_COOKIE_SECRET=...   # openssl rand -base64 32
SCRAPER_INGEST_TOKEN=...      # openssl rand -hex 32
SIGN_IN_EMAIL_DOMAINS=ucsf.edu   # who can sign in at all (this is the default)
AUTO_APPROVE_EMAIL_DOMAINS=      # optional: set to ucsf.edu to skip staff approval for new students
```

Create the tables, make yourself the first admin, and start the app:

```bash
pnpm prisma migrate dev --name init         # creates prisma/migrations/… and applies it
pnpm grant-access you@ucsf.edu admin        # applies when you first sign in with that address
pnpm dev                                    # http://localhost:3000, create an account with your UCSF email
```

Before any database or sign-in is configured, `pnpm dev` still runs on sample data kept in your browser. The top bar shows "Sample data" when that's happening. A production build refuses to start without them.

## Who can do what

| | Student | Staff | Admin |
|---|---|---|---|
| Live job board, dashboard, company info | ✓ | ✓ | ✓ |
| Own saved/applied lists, notes, dashboard layout (private to that person) | ✓ | ✓ | ✓ |
| Send company requests and issue reports | ✓ | ✓ | ✓ |
| Review queue, add/edit/import/remove postings, bin, categories | | ✓ | ✓ |
| Read and resolve requests and reports | | ✓ | ✓ |
| Approve or block students, invite students | | ✓ | ✓ |
| Make people staff or admin, remove a person and their data | | | ✓ |

Manage people on **Admin → People & access**. An invite by email takes effect the first time that person signs in with a confirmed address (a code sent to it), so nobody can claim an invite by typing someone else's email. Only addresses that can sign in can be invited. Nobody can change their own role, and the last admin can't be removed. Every access change, bulk import and permanent delete is written to the `AuditLog` table.

## How the data is protected

- **No public database endpoint.** `neon.ts` turns on Neon Auth only. The Neon Data API (a REST endpoint into Postgres) stays off, and database credentials live only in server environment variables.
- **UCSF only.** The auth route only creates accounts for, sends codes to and signs in `SIGN_IN_EMAIL_DOMAINS` addresses, and `lib/server/access.ts` turns away any other address on every request, so a session obtained some other way still gets nothing.
- **Every request is checked.** `proxy.ts` sends anyone without a session to `/auth/sign-in`. Each server action in `lib/actions.ts` and `lib/people-actions.ts` then checks the caller's role and access status in `lib/server/access.ts` before it touches the database. Input is validated with zod.
- **Scoped reads.** Students only ever receive live postings and their own lists, notes, requests and reports. Postings in the review queue, the bin, and other people's data never reach a student's browser.
- **Scraper ingest.** `/api/ingest`, `/api/ingest/open` and `/api/ingest/close` take a bearer token (`SCRAPER_INGEST_TOKEN`, compared in constant time). It only adds to the review queue, or updates postings already on the board.
- **Browser hardening.** Headers in `next.config.ts` block framing, MIME sniffing and search-engine indexing (HSTS, CSP `frame-ancestors 'none'`). Server actions only accept same-origin requests.
- **Tests:** `tests/access.test.mts` runs the real server actions against a throwaway Postgres to check these rules:

  ```bash
  createdb aicd3_test
  DATABASE_URL_UNPOOLED=postgresql://localhost/aicd3_test pnpm prisma db push
  TEST_DATABASE_URL=postgresql://localhost/aicd3_test pnpm test
  ```

## Refreshing postings with Claude Code

The `/scrape-internships` skill and the `posting-extractor` subagent live in your local `.claude/` folder, which isn't committed. Run it from the repository root in the Claude Code CLI:

```
/scrape-internships
```

The skill (`.claude/skills/scrape-internships/SKILL.md`, local) runs these steps:

1. `scraper/pharma_internships.py --details --workers 5`. Five companies run side by side, each site at its own polite pace, which takes roughly 10–15 minutes.
2. It splits the results into batches.
3. It starts several `posting-extractor` subagents (`.claude/agents/`, local) at once. They write a summary, responsibilities, qualifications, category, term and work mode for each posting.
4. It merges their output.
5. It sends the result to `/api/ingest` after a dry run and your OK.

Set `AICD3_URL` and `AICD3_INGEST_TOKEN` in your shell for step 5. Or upload `scraper/out/import.json` on **Admin → Import postings**.

**Matching and locations.** Each posting keeps the company's own job ID (`req_id`, e.g. `R-254668`), shown in the job details and searchable on the job board and Admin page. An import matches postings by company + job ID first, then by link, then by title, so a retitled posting or a moved Workday link updates the existing posting instead of creating a new one. Locations are cleaned up on the way in (`lib/locations.ts`, and `normalize_location` in the scraper): "US - New Jersey - Rahway" becomes "Rahway, NJ", "United States - Remote" becomes "Remote (US)", so they line up with the map.

**Checking what's still open.** Between full scrapes, re-check every open posting's own page:

```bash
python3 scraper/check_open.py            # report: still open / closed / couldn't check
python3 scraper/check_open.py --apply    # also mark the closed ones "Taken down"
```

It reads the open postings from `/api/ingest/open`, asks Workday's detail record, Greenhouse's job board API, or the posting page itself, at the same polite pace as the scraper, and sends closed ones to `/api/ingest/close`. Anything it can't confirm (a bot check, a timeout, a server error) is left alone. Staff can reopen a posting from the Admin page if a check was wrong; every closure is in the audit log.

On Bedrock, pin the model so the subagents use it too (they inherit it):

```bash
CLAUDE_CODE_USE_BEDROCK=1 AWS_REGION=us-east-1 claude --model us.anthropic.claude-sonnet-5
```

The scraper can also run on its own: `pip install -r scraper/requirements.txt`, then `python3 scraper/pharma_internships.py --help`. Its tests are `cd scraper && python3 -m unittest test_pharma_internships test_extract test_check_open`.

## Deploying (Vercel)

1. **Email + password with codes.** In the Neon Console (production branch), **Settings → Better Auth**: turn on **Sign-up and Sign-in with Email**, turn on **Verify at Sign-up** with the method **Verification code** (without it, someone could sign up with an address they don't own; they'd still wait for staff approval, but leave it on), and remove any Google or other OAuth provider. Under **Settings → Auth**, add a custom SMTP sender (UCSF mail, Resend, SendGrid…); Neon's shared sender is rate-limited and meant for testing. Set the application name to "AICD3 Job Board" so the emails say who they're from.
2. **Trusted domains.** Under **Auth → Trusted domains**, add your production domain. If you use Vercel previews, add `https://*.vercel.app`-style patterns too.
3. **Environment variables.** Add the `.env.local` values in Vercel: `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `NEON_AUTH_BASE_URL`, `NEON_AUTH_COOKIE_SECRET`, `SCRAPER_INGEST_TOKEN`, and `SIGN_IN_EMAIL_DOMAINS` / `AUTO_APPROVE_EMAIL_DOMAINS` if you set them.
4. **Localhost.** Turn off **Allow Localhost** in Neon Auth once you're done testing locally.
5. **Schema changes.** Make them on a Neon branch (`neon checkout dev`, `pnpm prisma migrate dev`), then run `pnpm db:deploy` against production.

The build runs `prisma generate && next build`.

## How it's put together

- **Routes:** `app/(app)/…` holds the signed-in app: `/`, `/jobs`, `/companies`, `/admin` and `/settings`, wrapped in `components/AppShell.tsx`. Sign-in lives at `app/auth/sign-in`, and the auth proxy at `app/api/auth/[...path]`.
- **Client data:** `lib/backend.ts` is the hook the pages use. It loads everything with `loadState()`, updates the screen immediately on a change, and sends the change to a server action. If a write fails, it reloads.
- **Server:** `lib/server/db.ts` holds the Prisma client, using the Neon adapter on Neon and node-postgres elsewhere. Next to it, `lib/server/access.ts` covers who is calling and what they may do, and `lib/server/postings.ts` covers validation, the conversion between rows and postings, and imports.
- **Schema:** `prisma/schema.prisma`.
- **Styling:** Tailwind CSS v3 with the tokens in `app/globals.css`. UI pieces are shadcn/ui on Radix, charts use ECharts, and the map uses d3-geo.
