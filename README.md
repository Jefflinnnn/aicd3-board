# AICD3 Job Board

Internship postings from pharma, biotech and startup companies, tracked for AICD3 students: a dashboard, a filterable job board, company info, and a staff-only admin area with a review queue.

**Live demo: [aicd3-board-demo.vercel.app](https://aicd3-board-demo.vercel.app/)**, no sign-in needed. It's the full app (dashboard, job board, company info and the staff admin area with its review queue) running on made-up postings from made-up companies (Company A, Company B…). Anything you change stays in your own browser. The real board is for UCSF students and needs a UCSF sign-in; see [Public demo](#public-demo) for how the demo is deployed.

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

# 3. Link this folder to the Neon project (then switch to the dev branch: see "Local development database")
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

## Loading postings

**From the Admin page.** **Job data refresh** has a **Refresh now** button and a switch for **Refresh automatically every 2 days**. The app's own server runs the pipeline below in the background (a full run takes 10–30 minutes; you can leave the page), shows its progress and keeps a history of runs with what each one changed. This needs a server that can run Python, i.e. the app started with `pnpm dev` or `pnpm build && pnpm start` on your Mac or another computer, with `pip install -r scraper/requirements.txt` done and `SCRAPER_INGEST_TOKEN` set. The automatic refresh only happens while that server is running. On Vercel the panel explains that it can't run there. If Python isn't plain `python3` (for example a virtualenv), set `SCRAPER_PYTHON` to its path.

**From a terminal**, the same pipeline:

```bash
pip install -r scraper/requirements.txt
python3 scraper/pipeline.py --dry-run   # what would change; nothing saved
python3 scraper/pipeline.py             # scrape, classify, load into the database, re-check open postings
```

It needs the app running (`pnpm dev`, or `--url https://your-app`) and `SCRAPER_INGEST_TOKEN` in `.env.local` (any long random value, e.g. `openssl rand -hex 32`; restart the app after adding it). It scrapes every company's US internships, then asks two questions of each posting (`scraper/classify.py`):

- **Is there real computational work?** (programming, data analysis, statistics, ML/AI, bioinformatics, modeling, building tools). Confident yes: published. Unsure: sent to the staff review queue with the model's confidence. No: left out.
- **Which area?** Drug discovery (before clinical trials), drug development (during clinical trials), tech (not tied to a drug stage), or other. This becomes the posting's category.

**Classifying with Claude (recommended).** Put the same Bedrock settings Claude Code uses in `.env.local`: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `ANTHROPIC_BEDROCK_BASE_URL` (UCSF's gateway) and optionally `ANTHROPIC_DEFAULT_SONNET_MODEL` (default `us.anthropic.claude-sonnet-5`; or `ANTHROPIC_API_KEY` for the Anthropic API; `AICD3_LLM_MODEL` overrides the model), then restart the app. **UCSF's gateway only answers on the UCSF network or VPN**: each run checks it first, and off the VPN the log and the Admin page say "connect to the UCSF VPN" and that run uses keyword rules. Each new or changed posting gets one call: Claude answers both questions with a one-line reason (shown on review-queue items) and writes the summary, responsibilities and qualifications, so odd heading styles don't matter. Answers are cached, so a refresh only sends new postings, four at a time. If calls fail, that posting falls back to keyword rules; after five failures the rest of the run does. Check the settings with `python3 scraper/classify.py --check --classifier llm`. The Admin page shows "Classifier: Claude" once it's set up.

The classifier is [vllm-sr/d3-flash](https://huggingface.co/vllm-sr/d3-flash), a 9B decision model run locally with `transformers` (install the commented packages in `scraper/requirements.txt`; it needs an NVIDIA GPU or an Apple-silicon Mac with about 20 GB of free memory, and downloads about 17 GB on first use). The Admin page's **Set up d3-flash** button (or `bash scraper/setup_d3.sh` on a Mac or Linux, `powershell -ExecutionPolicy Bypass -File scraper\setup_d3.ps1` on Windows) does all of it in one go, on an Apple-silicon Mac or a PC with an NVIDIA GPU (20 GB or more): it builds a separate Python environment (`.venv-d3`), installs the packages, downloads the model, classifies a sample, and points the Refresh button at that environment (`SCRAPER_PYTHON` and a pinned `D3_REVISION` in `.env.local`). Docker isn't used for this because containers on a Mac can't reach its GPU. `python3 scraper/classify.py --check` loads the model and classifies one sample. If it can't load, the pipeline falls back to keyword rules and says so. Every run writes `scraper/out/pipeline/fit.csv` listing each posting, the decision and the confidence.

**When a run fails.** Each run writes a full log to `scraper/out/logs/pipeline-<date>-<time>.log` (the last 30 are kept), whether it was started from the Admin page or a terminal. The log marks each stage (`[step] 1/4 scrape`, `2/4 classify`, `3/4 import`, `4/4 re-check open postings`) with how long it took, and ends with `[run] finished` or `[run] FAILED during step: …` and the reason. On the Admin page, every run has a **Log** link with its last 400 lines, and a failed run shows the reason under it. The app's terminal (`pnpm dev` / `pnpm start`) prints a `[refresh]` line when a run starts and ends, with the last lines of a failed one. A run that was going when the app restarted or closed is marked failed with "the app restarted or was closed while this run was going", because the run ends with the app. If re-checking open postings fails, the import before it is still saved and the run says so.

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

**Matching and locations.** Each posting keeps the company's own job ID (`req_id`, e.g. `R-254668`), shown in the job details and searchable on the job board and Admin page. An import matches postings by company + job ID first, then by link, then by title, so a retitled posting or a moved Workday link updates the existing posting instead of creating a new one. Locations are cleaned up on the way in (`lib/locations.ts`, and `normalize_location` in the scraper): "US - New Jersey - Rahway" becomes "Rahway, NJ", "Princeton - NJ - US" becomes "Princeton, NJ", "United States - Remote" becomes "Remote (US)", so they line up with the map. Workday sites that list a US city without its state ("SLEEPY HOLLOW", "South San Francisco") get the state from the description or a table of known sites.

**Checking what's still open.** Between full scrapes, re-check every open posting's own page:

```bash
python3 scraper/check_open.py            # report: still open / closed / needs a manual check
python3 scraper/check_open.py --apply    # mark the closed ones "Taken down", send the unsure ones to review
```

It reads the open postings from `/api/ingest/open`, asks Workday's detail record, Greenhouse's or Ashby's job board API, or the posting page itself, at the same polite pace as the scraper, and sends closed ones to `/api/ingest/close`. A posting it can't confirm either way (a bot check, a timeout, a server error) goes to the staff review queue through `/api/ingest/flag`, marked "Couldn't confirm it's still open" with the reason: Approve puts it back on the job board, Reject keeps it off. If every posting on one site fails (the whole site is down), those stay on the board and are only reported; add `--flag-site-outages` to send them to review anyway. Staff can reopen a closed posting from the Admin page if a check was wrong; every closure and flag is in the audit log.

On Bedrock, pin the model so the subagents use it too (they inherit it):

```bash
CLAUDE_CODE_USE_BEDROCK=1 AWS_REGION=us-east-1 claude --model us.anthropic.claude-sonnet-5
```

**Sites behind bot checks (Eli Lilly).** Lilly's Workday (`lilly.wd115…`) sits behind Cloudflare, which refuses Python's own way of connecting even though a real browser gets straight through, and all of Lilly's US internships are on its campus board (CMP). The scraper tries three routes in order and the run log says which one worked: Chrome's connection fingerprint via `curl_cffi` (in `requirements.txt`), then the same boards through headless Chromium (`pip install playwright && playwright install chromium`; the GitHub refresh installs it), then careers.lilly.com, which only mirrors the main LLY board. Re-checking open Lilly postings uses the Chrome fingerprint too. Mark another company the same way with `"impersonate": True` in `COMPANIES`.

By default the scraper also uses routes robots.txt disallows: today that's AbbVie's job search, which has real titles, locations, pay, work type, R-numbers and expiry dates. Pass `--respect-robots` to use allowed routes only (the AbbVie sitemap instead), which still covers every company. The pace is the same either way (one request at a time per site, 1.5–3 s apart) and it still stops at bot checks. Check the sites' terms of use. When Workday is down (weekend maintenance), Genentech falls back to careers.gene.com automatically.

The scraper can also run on its own: `pip install -r scraper/requirements.txt`, then `python3 scraper/pharma_internships.py --help`. Its tests are `cd scraper && python3 -m unittest test_pharma_internships test_extract test_check_open`.

## Deploying (Vercel)

1. **Email + password with codes.** In the Neon Console (production branch), **Settings → Better Auth**: turn on **Sign-up and Sign-in with Email**, turn on **Verify at Sign-up** with the method **Verification code** (without it, someone could sign up with an address they don't own; they'd still wait for staff approval, but leave it on), and remove any Google or other OAuth provider. Under **Settings → Auth**, add a custom SMTP sender (UCSF mail, Resend, SendGrid…); Neon's shared sender is rate-limited and meant for testing. Set the application name to "AICD3 Job Board" so the emails say who they're from.
2. **Trusted domains.** Under **Auth → Trusted domains**, add your production domain. If you use Vercel previews, add `https://*.vercel.app`-style patterns too.
3. **Environment variables.** In Vercel (Settings → Environment Variables, **Production**), add the production branch's values: `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `NEON_AUTH_BASE_URL`, `NEON_AUTH_COOKIE_SECRET`, `SCRAPER_INGEST_TOKEN`, and `SIGN_IN_EMAIL_DOMAINS` / `AUTO_APPROVE_EMAIL_DOMAINS` if you set them. `DATABASE_URL_UNPOOLED` is required: production deploys apply migrations with it. These are the only place production credentials live; your own `.env.local` points at a dev branch (below).
4. **Localhost.** Turn off **Allow Localhost** in Neon Auth on the production branch. Local development signs in through the dev branch's own Neon Auth, which can keep it on.
5. **Region.** `vercel.json` runs the server in Portland (`pdx1`), next to the Neon database in Oregon (us-west-2), so each query stays on the West Coast. If you ever move the database, change both.
6. **Wait for checks.** In Vercel, **Settings → Git**, turn on waiting for GitHub checks before promoting a production deployment (or, in GitHub, add a branch protection rule on `main` that requires the **CI** workflow). Then a failing check stops a deploy from reaching students.

**What a deploy does.** Vercel runs `pnpm vercel-build` (`scripts/vercel-build.mjs`): on a production deploy it first runs `prisma migrate deploy` against the production database, then `prisma generate && next build`. Preview deploys skip the migration step, so a branch can never change production's schema. Keep migrations additive (new tables, new columns that are nullable or have a default) so the previous code still works if a build fails after migrating.

**Errors.** Every unhandled error in a page, route or server action is logged as one JSON line with `"event":"request-error"` (`instrumentation.ts`, no request bodies or cookies). Find them in Vercel under **Logs**, filtered by `request-error`; locally they print in the terminal.

## Public demo

A copy of the site anyone can open, to show the board to people outside UCSF: the same dashboard, job board and company pages with made-up postings from made-up companies (Company A, Company B…), no links out, and a banner saying it's a demo with a link to the real board. Visitors act as a student; what they save stays in their own browser. There's no sign-in, no Admin page, and `/api/*` answers 404.

Deploy it as a **second Vercel project** from the same GitHub repo (e.g. `aicd3-demo`), with only these environment variables:

```bash
DEMO_MODE=1
NEXT_PUBLIC_REAL_SITE_URL=https://your-real-site.vercel.app   # optional: the banner links here
```

Give it **no** database, Neon Auth or scraper variables. Even if some were set by mistake, demo mode never reads or writes the database (`tests/access.test.mts` checks this). Try it locally with `pnpm dev:demo` (http://localhost:3001, alongside `pnpm dev` on :3000; plain `pnpm dev` is always the real site).

## Local development database

Work locally against a **dev branch** of the Neon database, never production. A branch is a full copy of production's data made in seconds, so you can test edits, imports and refreshes without students seeing them. `pnpm dev` prints a warning if `.env.local` still points at production.

```bash
# once: create the branch (Neon Console → Branches → New branch, parent "production", name "dev"),
# then point this folder at it and write its connection strings to .env.local
neon checkout dev
neon deploy               # turns on Neon Auth for the dev branch and writes its URLs to .env.local
grep NEON_BRANCH .env.local   # should say dev
pnpm grant-access you@ucsf.edu admin
pnpm dev
```

Keep the lines you added yourself (`NEON_AUTH_COOKIE_SECRET`, `SCRAPER_INGEST_TOKEN`, …) in `.env.local`. To start over from fresh production data, reset the branch from its parent in the Neon Console (Branches → dev → Reset from parent).

**Schema changes.** Make them on the dev branch with `pnpm db:migrate` (`prisma migrate dev`), commit the new folder in `prisma/migrations/`, and push. The production deploy applies it; there's no manual `db:deploy` step anymore.

## Checks and automation (GitHub Actions)

- **CI** (`.github/workflows/ci.yml`) runs on every push and pull request: type check, lint, the access-rule tests against a throwaway Postgres, the scraper's tests, and a production build. Run the same locally with `pnpm check` and `pnpm test`.
- **Job data refresh** (`.github/workflows/refresh.yml`) runs the scraper pipeline every other day on GitHub's machines and sends the results to the live site, so no computer has to stay on. It uses the keyword-rule classifier (no GPU there). Add two repository secrets (GitHub → Settings → Secrets and variables → Actions): `AICD3_URL` (the live site's address) and `AICD3_INGEST_TOKEN` (the same value as `SCRAPER_INGEST_TOKEN` in Vercel). Start a run by hand from the **Actions** tab → **Job data refresh** → **Run workflow** (with a dry-run option). Each run keeps its log and `fit.csv` for 14 days under the run's **Artifacts**. If you use this, turn off **Refresh automatically** on the Admin page of any local copy, so the two don't both refresh.
- **Node** is pinned to 22 (`.nvmrc`, `engines` in `package.json`), the same on Vercel, in CI and locally (`nvm use`).

## How it's put together

- **Routes:** `app/(app)/…` holds the signed-in app: `/`, `/jobs`, `/companies`, `/admin` and `/settings`, wrapped in `components/AppShell.tsx`. Sign-in lives at `app/auth/sign-in`, and the auth proxy at `app/api/auth/[...path]`.
- **Client data:** `lib/backend.ts` is the hook the pages use. It loads everything with `loadState()`, updates the screen immediately on a change, and sends the change to a server action. If a write fails, it reloads.
- **Server:** `lib/server/db.ts` holds the Prisma client, using the Neon adapter on Neon and node-postgres elsewhere. Next to it, `lib/server/access.ts` covers who is calling and what they may do, and `lib/server/postings.ts` covers validation, the conversion between rows and postings, and imports.
- **Schema:** `prisma/schema.prisma`.
- **Styling:** Tailwind CSS v3 with the tokens in `app/globals.css`. UI pieces are shadcn/ui on Radix, charts use ECharts, and the map uses d3-geo.
