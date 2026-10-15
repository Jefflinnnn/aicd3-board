/**
 * Who can see and change what. Runs the real server actions against a throwaway Postgres
 * database, with Neon Auth replaced by a fake session.
 *
 *   createdb aicd3_test
 *   DATABASE_URL_UNPOOLED=postgresql://localhost/aicd3_test pnpm prisma db push
 *   TEST_DATABASE_URL=postgresql://localhost/aicd3_test pnpm test
 *
 * Never point TEST_DATABASE_URL at a real database: every run empties it.
 */
import { after, before, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"

const url = process.env.TEST_DATABASE_URL
if (!url) throw new Error("Set TEST_DATABASE_URL to an empty, throwaway Postgres database.")
if (/neon\.tech/.test(url)) throw new Error("TEST_DATABASE_URL must not be a Neon database; this test deletes everything in it.")
process.env.DATABASE_URL = url
process.env.NEON_AUTH_BASE_URL = "https://auth.invalid"
process.env.NEON_AUTH_COOKIE_SECRET = "x".repeat(40)
process.env.SIGN_IN_EMAIL_DOMAINS = "school.edu,program.org,gmail.com"
process.env.AUTO_APPROVE_EMAIL_DOMAINS = "school.edu"
process.env.SCRAPER_INGEST_TOKEN = "t".repeat(48)
// a stand-in for `python3 scraper/pipeline.py`: prints a line, writes the summary, exits with FAKE_EXIT
{
  const fs = await import("node:fs")
  const os = await import("node:os")
  const fake = `${os.tmpdir()}/aicd3-fake-python.sh`
  fs.writeFileSync(fake, `#!/bin/sh
if [ "$1" = "-c" ]; then exit 0; fi
while [ $# -gt 0 ]; do if [ "$1" = "--summary-json" ]; then out="$2"; fi; shift; done
echo "scraping Gilead Sciences"
sleep \${FAKE_SLEEP:-0}
echo '{"classifier":"rules","scraped":3,"publish":1,"review":1,"skip":1,"database":{"added":1,"staged":1,"updated":0,"closed":0,"unchanged":0,"rejected":0},"errors":0,"checked":null,"companies":{"Gilead Sciences":"ok (3)"},"failed":[]}' > "$out"
exit \${FAKE_EXIT:-0}
`, { mode: 0o755 })
  process.env.SCRAPER_PYTHON = fake
  process.env.SCRAPER_SCHEDULER = "off"
}

type FakeUser = { id: string; email: string; emailVerified: boolean; name: string }
let current: FakeUser | null = null
;(globalThis as Record<string, unknown>).__neonAuth = {
  getSession: async () => ({ data: current ? { user: current, session: { id: "s" } } : null, error: null }),
}
const as = (u: FakeUser | null) => { current = u }
const user = (id: string, email: string, emailVerified = true): FakeUser => ({ id, email, emailVerified, name: id })

const A = await import("../lib/actions")
const P = await import("../lib/people-actions")
const R = await import("../lib/refresh-actions")
const RS = await import("../lib/server/refresh")
const { db } = await import("../lib/server/db")
const { POST: ingest } = await import("../app/api/ingest/route")
const authRoute = await import("../app/api/auth/[...path]/route")
const openRoute = await import("../app/api/ingest/open/route")
const closeRoute = await import("../app/api/ingest/close/route")
const flagRoute = await import("../app/api/ingest/flag/route")
const progressRoute = await import("../app/api/ingest/progress/route")
const prisma = db()

const job = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: "Data Science Intern", company: "amgen", location: "Thousand Oaks, CA", locations: ["Thousand Oaks, CA"],
  category: "tech", posted: "2026-10-01", deadline: "2026-12-01", term: "Summer 2027", mode: "Onsite", pay: "$40/hr",
  url: "https://careers.amgen.com/job/" + id, summary: "x".repeat(120), resp: ["Build models"], quals: ["Python"], ...extra,
})
const rejects = (p: Promise<unknown>, re = /permission|approval|sign in|access/i) => assert.rejects(p, re)

async function wipe() {
  for (const t of ["ScrapeRun", "JobStatus", "JobNote", "CompanyRequest", "IssueReport", "Posting", "AccessGrant", "Profile", "SiteMeta", "AuditLog"])
    await prisma.$executeRawUnsafe(`DELETE FROM "${t}"`)
}

const admin = user("u-admin", "lead@program.org")
const staff = user("u-staff", "coord@program.org")
const alice = user("u-alice", "alice@school.edu")
const bob = user("u-bob", "bob@school.edu")
const outsider = user("u-out", "someone@gmail.com")

before(wipe)
after(async () => { await wipe(); await prisma.$disconnect() })

describe("signing in", () => {
  beforeEach(wipe)

  it("signed-out callers get nothing", async () => {
    as(null)
    assert.equal((await A.loadState()).mode, "signedout")
    await rejects(A.setStatus(["x"], "saved"))
  })

  it("an unknown email waits for approval and can't read or write", async () => {
    as(outsider)
    const r = await A.loadState()
    assert.equal(r.mode, "pending")
    assert.ok(!("jobs" in r))
    await rejects(A.setNote("x", "hi"))
    await rejects(A.addRequest({ id: "r1", name: "Acme", site: "", cat: "", email: "", why: "", date: "2026-10-08" }))
  })

  it("a verified address at an allowed domain is an active student", async () => {
    as(alice)
    const r = await A.loadState()
    assert.equal(r.mode, "cloud")
    if (r.mode === "cloud") {
      assert.equal(r.me.role, "student")
      assert.equal(r.me.canEdit, false)
      assert.equal(r.staff, undefined)
    }
  })

  it("an unverified address at an allowed domain still waits", async () => {
    as(user("u-unv", "eve@school.edu", false))
    assert.equal((await A.loadState()).mode, "pending")
  })

  it("a staff invite applies on first sign-in, only to a verified address", async () => {
    await prisma.accessGrant.create({ data: { email: "coord@program.org", role: "staff" } })
    as({ ...staff, id: "u-fake", emailVerified: false })
    assert.equal((await A.loadState()).mode, "pending")
    as(staff)
    const r = await A.loadState()
    assert.equal(r.mode, "cloud")
    if (r.mode === "cloud") assert.equal(r.me.role, "staff")
    assert.equal(await prisma.accessGrant.count(), 0)
  })

  it("addresses outside the sign-in domains get nothing, and no profile is kept", async () => {
    const stranger = user("u-yahoo", "someone@yahoo.com")
    as(stranger)
    assert.equal((await A.loadState()).mode, "outside")
    await rejects(A.setStatus(["x"], "saved"))
    await rejects(A.addReport({ id: "i9", kind: "x", jobId: "", details: "", email: "", date: "2026-10-09" }))
    assert.equal(await prisma.profile.count({ where: { id: stranger.id } }), 0)
  })

  it("the auth route only serves allowed domains and refuses social sign-in, magic links and email changes", async () => {
    const call = (path: string, body: unknown) =>
      authRoute.POST(new Request("http://localhost/api/auth/" + path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
        { params: Promise.resolve({ path: path.split("/") }) })
    assert.equal((await call("email-otp/send-verification-otp", { email: "someone@yahoo.com", type: "sign-in" })).status, 403)
    assert.equal((await call("sign-in/email-otp", { email: "someone@yahoo.com", otp: "123456" })).status, 403)
    assert.equal((await call("email-otp/send-verification-otp", { email: "alice@school.edu", type: "change-email" })).status, 400)
    assert.equal((await call("sign-in/email", { email: "someone@yahoo.com", password: "x" })).status, 403)
    assert.equal((await call("sign-up/email", { email: "someone@yahoo.com", password: "longenough", name: "x" })).status, 403)
    assert.equal((await call("email-otp/reset-password", { email: "someone@yahoo.com", otp: "1", password: "x" })).status, 403)
    assert.equal((await call("sign-in/social", { provider: "google" })).status, 404)
    assert.equal((await call("sign-in/magic-link", { email: "alice@school.edu" })).status, 404)
    assert.equal((await call("email-otp/request-email-change", { email: "alice@school.edu", newEmail: "a@yahoo.com" })).status, 404)
  })

  it("blocked accounts are refused", async () => {
    as(alice)
    await A.loadState()
    await prisma.profile.update({ where: { id: alice.id }, data: { status: "blocked" } })
    assert.equal((await A.loadState()).mode, "blocked")
    await rejects(A.setStatus(["x"], "saved"))
  })
})

describe("students", () => {
  before(async () => {
    await wipe()
    await prisma.profile.create({ data: { id: admin.id, email: admin.email, emailVerified: true, role: "admin", status: "active" } })
    await prisma.profile.create({ data: { id: staff.id, email: staff.email, emailVerified: true, role: "staff", status: "active" } })
    as(staff)
    await A.saveJobs([job("live1"), job("live2")])
    await A.saveStaged([{ ...job("held1"), review: { flags: ["check"], source: "import", at: Date.now(), status: "pending" } }])
  })

  it("see live postings only, never the review queue", async () => {
    as(alice)
    const r = await A.loadState()
    assert.equal(r.mode, "cloud")
    if (r.mode !== "cloud") return
    assert.deepEqual(r.jobs.map((j) => j.id).sort(), ["live1", "live2"])
    assert.equal(r.staff, undefined)
  })

  it("can't save or note a posting they can't see", async () => {
    as(alice)
    await A.setStatus(["held1"], "saved")
    await A.setNote("held1", "secret")
    assert.equal(await prisma.jobStatus.count({ where: { postingId: "held1" } }), 0)
    assert.equal(await prisma.jobNote.count({ where: { postingId: "held1" } }), 0)
  })

  it("keep their own lists and notes, invisible to other students", async () => {
    as(alice)
    await A.setStatus(["live1"], "applied")
    await A.setNote("live1", "alice's note")
    as(bob)
    const r = await A.loadState()
    if (r.mode !== "cloud") return assert.fail("bob should be active")
    assert.deepEqual(r.mine.status, {})
    assert.deepEqual(r.mine.notes, {})
    as(alice)
    const ra = await A.loadState({ refresh: true })
    if (ra.mode !== "cloud") return assert.fail()
    assert.equal(ra.mine.status.live1, "applied")
    assert.equal(ra.mine.notes.live1, "alice's note")
  })

  it("can't call any staff action", async () => {
    as(alice)
    await rejects(A.saveJobs([job("evil")]))
    await rejects(A.approve(["held1"]))
    await rejects(A.moveToBin(["live1"]))
    await rejects(A.deleteForever(["live1"]))
    await rejects(A.pullToReview(["live1"], "x"))
    await rejects(A.setCustomCats([]))
    await rejects(A.resolveInbox(alice.id, "requests", "r1"))
    await rejects(A.importPostings("[]", { closeMissing: false, reviewAll: true, dryRun: true }))
    await rejects(P.listPeople())
    await rejects(P.invite("x@y.com", "admin"))
    await rejects(P.setAccess(alice.id, { role: "admin" }))
    assert.equal(await prisma.posting.count({ where: { id: "evil" } }), 0)
  })

  it("requests and reports go to staff, with the sender's name", async () => {
    as(alice)
    await A.addReport({ id: "i1", kind: "Posting has closed", jobId: "live1", details: "gone", email: "", date: "2026-10-08" })
    as(staff)
    const r = await A.loadState({ refresh: true })
    if (r.mode !== "cloud" || !r.staff) return assert.fail()
    assert.equal(r.staff.inbox.find((d) => d.uid === alice.id)?.reports[0].id, "i1")
    assert.equal(r.staff.names[alice.id], alice.name)
    await A.resolveInbox(alice.id, "reports", "i1")
    as(alice)
    const ra = await A.loadState({ refresh: true })
    if (ra.mode !== "cloud") return assert.fail()
    assert.equal(ra.myInbox.reports.length, 0)
  })

  it("an edit from a stale screen can't put a pulled posting back on the board", async () => {
    as(staff)
    await A.saveJobs([job("live3")])
    await A.pullToReview(["live3"], "looks wrong")
    await A.saveJobs([{ ...job("live3"), title: "Data Science Intern (edited)" }])
    assert.equal((await prisma.posting.findUnique({ where: { id: "live3" } }))?.state, "review")
    await A.approve(["live3"])
    assert.equal((await prisma.posting.findUnique({ where: { id: "live3" } }))?.state, "live")
  })

  it("rejects malformed input", async () => {
    as(alice)
    await assert.rejects(A.setNote("../../etc", "x"))
    await assert.rejects(A.setStatus(["live1"], "hacked" as never))
    as(staff)
    await assert.rejects(A.saveJobs([{ ...job("bad"), url: "javascript:alert(1)" }]))
  })
})

describe("staff provisioning", () => {
  before(async () => {
    await wipe()
    await prisma.profile.create({ data: { id: admin.id, email: admin.email, emailVerified: true, role: "admin", status: "active" } })
    await prisma.profile.create({ data: { id: staff.id, email: staff.email, emailVerified: true, role: "staff", status: "active" } })
    as(outsider)
    await A.loadState()
  })

  it("staff approve students but can't make staff", async () => {
    as(staff)
    await P.setAccess(outsider.id, { status: "active" })
    assert.equal((await prisma.profile.findUnique({ where: { id: outsider.id } }))?.status, "active")
    await rejects(P.setAccess(outsider.id, { role: "staff" }))
    await rejects(P.invite("new@program.org", "staff"))
    await assert.rejects(P.invite("someone@yahoo.com", "student"), /can sign in/)
    await rejects(P.setAccess(admin.id, { status: "blocked" }))
    await P.invite("newstudent@gmail.com", "student")
    assert.equal(await prisma.accessGrant.count({ where: { email: "newstudent@gmail.com" } }), 1)
  })

  it("admins make staff, but not themselves, and never remove the last admin", async () => {
    as(admin)
    await P.setAccess(outsider.id, { role: "staff" })
    assert.equal((await prisma.profile.findUnique({ where: { id: outsider.id } }))?.role, "staff")
    await assert.rejects(P.setAccess(admin.id, { role: "student" }), /own access/)
    await P.setAccess(staff.id, { role: "admin" })
    as(staff)
    await P.setAccess(admin.id, { role: "staff" }) // another admin remains: allowed
    await assert.rejects(P.removePerson(staff.id), /yourself/)
    as(admin)
    await rejects(P.removePerson(outsider.id)) // admin was demoted to staff above
  })

  it("invites never activate an unverified account, and unverified accounts can't be made staff", async () => {
    await prisma.profile.update({ where: { id: admin.id }, data: { role: "admin" } }) // demoted in the test above
    const fake = user("u-fake2", "victim@gmail.com", false)
    as(fake)
    await A.loadState()
    as(admin)
    const r = await P.invite("victim@gmail.com", "student")
    assert.equal(r.applied, false)
    assert.equal((await prisma.profile.findUnique({ where: { id: fake.id } }))?.status, "pending")
    await assert.rejects(P.setAccess(fake.id, { role: "staff" }), /verified/)
  })

  it("removing a person deletes their data and keeps them out", async () => {
    const carol = user("u-carol", "carol@school.edu")
    as(carol)
    assert.equal((await A.loadState()).mode, "cloud")
    await A.addRequest({ id: "rq9", name: "Acme Bio", site: "", cat: "", email: "", why: "", date: "2026-10-08" })
    as(admin)
    await P.removePerson(carol.id)
    assert.equal(await prisma.companyRequest.count({ where: { userId: carol.id } }), 0)
    as(carol)
    assert.equal((await A.loadState()).mode, "blocked")
  })

  it("a domain student set back to pending stays pending", async () => {
    const dan = user("u-dan", "dan@school.edu")
    as(dan)
    await A.loadState()
    as(staff)
    await P.setAccess(dan.id, { status: "pending" })
    as(dan)
    assert.equal((await A.loadState()).mode, "pending")
  })

  it("every change is in the audit log", async () => {
    assert.ok((await prisma.auditLog.count({ where: { action: { startsWith: "access." } } })) >= 3)
  })
})

describe("scraper ingest", () => {
  before(wipe)
  const post = (body: string, token?: string, qs = "") =>
    ingest(new Request("http://localhost/api/ingest" + qs, { method: "POST", body, headers: token ? { authorization: "Bearer " + token } : {} }))
  const rows = JSON.stringify([
    { title: "Machine Learning Intern", company: "Amgen", locations: "Thousand Oaks, CA", category: "Tech", deadline: "", first_seen: "2026-10-01", url: "https://careers.amgen.com/job/R-1", description: "y".repeat(120), responsibilities: "Train models", qualifications: "Python" },
    { title: "Senior Director", company: "Pfizer", url: "https://pfizer.wd1.myworkdayjobs.com/x" },
    { title: "Intern", company: "Not A Company" },
  ])

  it("needs the token", async () => {
    assert.equal((await post(rows)).status, 401)
    assert.equal((await post(rows, "wrong")).status, 401)
  })

  it("sends new postings to the review queue, not to students", async () => {
    const r = await post(rows, process.env.SCRAPER_INGEST_TOKEN)
    const body = await r.json()
    assert.equal(r.status, 200)
    assert.equal(body.staged, 2)
    assert.equal(body.added, 0)
    assert.equal(body.errors.length, 1)
    assert.equal(await prisma.posting.count({ where: { state: "live" } }), 0)
    assert.equal(await prisma.posting.count({ where: { state: "review" } }), 2)
  })
})

describe("job IDs, locations and the open/closed check", () => {
  before(wipe)
  const token = () => process.env.SCRAPER_INGEST_TOKEN!
  const list = (t?: string) => openRoute.GET(new Request("http://localhost/api/ingest/open", { headers: t ? { authorization: "Bearer " + t } : {} }))
  const ingestJson = (rows: unknown[]) =>
    ingest(new Request("http://localhost/api/ingest?reviewAll=0", { method: "POST", body: JSON.stringify(rows), headers: { authorization: "Bearer " + token() } }))
  const base = {
    company: "Amgen", category: "Tech", first_seen: "2026-10-01", description: "z".repeat(120),
    responsibilities: ["Train models"], qualifications: ["Python"],
  }

  it("saves the job ID and cleans up Workday-style locations", async () => {
    const r = await ingestJson([{ ...base, title: "Data Science Intern", req_id: "R-111", locations: ["US - California - Thousand Oaks", "United States - Remote"],
      url: "https://amgen.wd1.myworkdayjobs.com/Careers/job/US-California-Thousand-Oaks/Data-Science-Intern_R-111" }])
    assert.equal((await r.json()).added, 1)
    const row = await prisma.posting.findFirst({ where: { reqId: "R-111" } })
    assert.ok(row)
    assert.deepEqual(row!.locations, ["Thousand Oaks, CA", "Remote (US)"])
  })

  it("recognises a posting by its job ID even when the title and link change", async () => {
    const r = await ingestJson([{ ...base, title: "Data Science Intern (Summer 2027)", req_id: "R-111", locations: ["US - California - Thousand Oaks"],
      url: "https://amgen.wd1.myworkdayjobs.com/en-US/Careers/job/US-California-Thousand-Oaks/Data-Science-Intern-Summer-2027_R-111" }])
    const body = await r.json()
    assert.equal(body.updated, 1)
    assert.equal(body.added + body.staged, 0)
    assert.equal(await prisma.posting.count({ where: { reqId: "R-111" } }), 1)
  })

  it("treats the same title with a different job ID as a different posting", async () => {
    const r = await ingestJson([{ ...base, title: "Data Science Intern (Summer 2027)", req_id: "R-222", locations: ["US - Massachusetts - Cambridge"],
      url: "https://amgen.wd1.myworkdayjobs.com/Careers/job/US-Massachusetts-Cambridge/Data-Science-Intern_R-222" }])
    assert.equal((await r.json()).added, 1)
  })

  it("lists open postings and marks the closed ones taken down, with the token only", async () => {
    assert.equal((await list()).status, 401)
    const open = (await (await list(token())).json()).postings as { id: string; reqId: string; url: string }[]
    assert.equal(open.length, 2)
    assert.ok(open.every((p) => p.reqId && p.url))
    const close = (body: unknown, t = token()) =>
      closeRoute.POST(new Request("http://localhost/api/ingest/close", { method: "POST", body: JSON.stringify(body), headers: { authorization: "Bearer " + t } }))
    assert.equal((await close({ ids: [open[0].id] }, "wrong")).status, 401)
    assert.equal((await close({ ids: ["../x"] })).status, 400)
    const out = await (await close({ ids: [open[0].id], reasons: { [open[0].id]: "Workday detail answered 404" } })).json()
    assert.equal(out.closed, 1)
    assert.equal((await prisma.posting.findUnique({ where: { id: open[0].id } }))?.closed, true)
    assert.equal((await (await list(token())).json()).postings.length, 1)
    assert.equal(await prisma.auditLog.count({ where: { action: "postings.check-closed" } }), 1)
  })

  it("sends postings the checker couldn't confirm to the review queue", async () => {
    const open = (await (await list(token())).json()).postings as { id: string }[]
    assert.equal(open.length, 1)
    const flag = (body: unknown, t = token()) =>
      flagRoute.POST(new Request("http://localhost/api/ingest/flag", { method: "POST", body: JSON.stringify(body), headers: { authorization: "Bearer " + t } }))
    assert.equal((await flag({ ids: [open[0].id] }, "wrong")).status, 401)
    const out = await (await flag({ ids: [open[0].id, "nope"], reasons: { [open[0].id]: "posting page answered 500" } })).json()
    assert.equal(out.flagged, 1)
    const row = await prisma.posting.findUnique({ where: { id: open[0].id } })
    assert.equal(row?.state, "review")
    const review = row?.review as { source: string; flags: string[]; status: string }
    assert.equal(review.source, "check")
    assert.equal(review.status, "pending")
    assert.match(review.flags[0], /Couldn't confirm.*answered 500/)
    assert.equal((await (await list(token())).json()).postings.length, 0) // not re-checked while in review
    assert.equal((await (await flag({ ids: [open[0].id] })).json()).flagged, 0) // already there
    assert.equal(await prisma.auditLog.count({ where: { action: "postings.check-unconfirmed" } }), 1)
  })
})


describe("pipeline imports", () => {
  before(wipe)
  const token = () => process.env.SCRAPER_INGEST_TOKEN!
  const ingestJson = (body: unknown, qs = "?reviewAll=0&closeMissing=1") =>
    ingest(new Request("http://localhost/api/ingest" + qs, { method: "POST", body: JSON.stringify(body), headers: { authorization: "Bearer " + token() } }))
  const rec = (title: string, extra: Record<string, unknown> = {}) => ({
    company: "gilead", title, category: "development", first_seen: "2026-09-08", locations: ["Foster City, CA"],
    url: "https://gilead.wd1.myworkdayjobs.com/gileadcareers/job/x/" + encodeURIComponent(title), description: "z".repeat(120),
    responsibilities: ["Analyze trial data"], qualifications: ["R or SAS"], ...extra,
  })

  it("publishes confident postings and sends the ones the classifier is unsure about to review", async () => {
    const out = await (await ingestJson({ postings: [
      rec("Intern - Development - Biostatistics", { req_id: "R0054649" }),
      rec("Intern - Data Analytics", { req_id: "R0054650", category: "other", review_reason: "Unsure it has computational work (48% by d3; 60% needed to publish)" }),
    ] })).json()
    assert.equal(out.added, 1)
    assert.equal(out.staged, 1)
    const held = await prisma.posting.findFirst({ where: { reqId: "R0054650" } })
    assert.equal(held?.state, "review")
    assert.ok((held?.review as { flags: string[] }).flags.some((f) => /Unsure it has computational work \(48%/.test(f)))
    const live = await prisma.posting.findFirst({ where: { reqId: "R0054649" } })
    assert.equal(live?.state, "live")
    assert.equal(live?.category, "development")
  })

  it("closes a company's postings that a later run no longer finds", async () => {
    const out = await (await ingestJson({ postings: [rec("Intern - CFO - IT", { req_id: "R0054789", category: "tech" })] })).json()
    assert.equal(out.added, 1)
    assert.equal(out.closed, 1)
    assert.equal((await prisma.posting.findFirst({ where: { reqId: "R0054649" } }))?.closed, true)
    // the posting the classifier was unsure about isn't in this run any more: it leaves the review queue
    assert.equal(out.dropped, 1)
    assert.equal(await prisma.posting.count({ where: { reqId: "R0054650" } }), 0)
  })

  it("moves a published posting that's no longer a fit to the bin instead of marking it taken down", async () => {
    const out = await (await ingestJson({ postings: [
      rec("Intern - CFO - IT", { req_id: "R0054789", category: "tech", fit: "no" }),
      rec("Intern - Never published", { req_id: "R0099999", fit: "no" }),
    ] })).json()
    assert.equal(out.unlisted, 1)
    assert.equal(out.added + out.staged, 0)
    assert.equal(out.closed, 0)
    const row = await prisma.posting.findFirst({ where: { reqId: "R0054789" } })
    assert.equal(row?.state, "bin")
    assert.equal(row?.closed, false)
    assert.equal(await prisma.posting.count({ where: { reqId: "R0099999" } }), 0)
    await prisma.posting.update({ where: { id: row!.id }, data: { state: "live", deletedAt: null } }) // back for the next test
  })

  it("never clears postings staff held or pulled back, or other companies' queue", async () => {
    const held = await prisma.posting.create({ data: {
      id: "held1", state: "review", title: "Intern - Held", company: "gilead", location: "Foster City, CA", locations: ["Foster City, CA"],
      category: "tech", posted: new Date("2026-09-01"), url: "https://gilead.example/held", resp: [], quals: [],
      review: { flags: ["Held by staff for a closer look"], source: "held", at: Date.now(), status: "pending" },
    } })
    const other = await prisma.posting.create({ data: {
      id: "other1", state: "review", title: "Intern - Other co", company: "amgen", location: "Thousand Oaks, CA", locations: ["Thousand Oaks, CA"],
      category: "tech", posted: new Date("2026-09-01"), url: "https://amgen.example/x", resp: [], quals: [],
      review: { flags: ["Unsure"], source: "import", at: Date.now(), status: "pending" },
    } })
    const out = await (await ingestJson({ postings: [rec("Intern - CFO - IT", { req_id: "R0054789", category: "tech" })] })).json()
    assert.equal(out.dropped, 0)
    assert.equal(await prisma.posting.count({ where: { id: { in: [held.id, other.id] } } }), 2)
  })
})

describe("job data refresh", () => {
  before(wipe)
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      const r = await prisma.scrapeRun.findFirst({ orderBy: { startedAt: "desc" } })
      if (r && r.status !== "running") return r
      await new Promise((ok) => setTimeout(ok, 100))
    }
    throw new Error("run never finished")
  }

  it("only staff can start one, and two clicks start one run", async () => {
    await prisma.profile.createMany({ data: [
      { id: admin.id, email: admin.email, emailVerified: true, role: "admin", status: "active" },
      { id: alice.id, email: alice.email, emailVerified: true, role: "student", status: "active" },
    ] })
    as(alice)
    await rejects(R.refreshNow())
    await rejects(R.getRefreshStatus())
    as(admin)
    process.env.FAKE_SLEEP = "1"
    const [a, b] = await Promise.all([R.refreshNow(), R.refreshNow()])
    assert.deepEqual([a.started, b.started].sort(), [false, true])
    assert.equal(await prisma.scrapeRun.count(), 1)
    const done = await settle()
    assert.equal(done.status, "succeeded")
    const st = await R.getRefreshStatus()
    assert.equal(st.problem, null)
    assert.equal(st.runs[0].summary?.database.added, 1)
    assert.equal(st.runs[0].by, admin.id)
    assert.match(st.runs[0].log, /scraping Gilead/)
    assert.equal(await prisma.auditLog.count({ where: { action: "refresh.start" } }), 1)
  })

  it("reports partial and failed runs, and can be stopped", async () => {
    as(admin)
    process.env.FAKE_SLEEP = "0"
    process.env.FAKE_EXIT = "2"
    await R.refreshNow()
    assert.equal((await settle()).status, "partial")
    process.env.FAKE_EXIT = "1"
    await R.refreshNow()
    assert.equal((await settle()).status, "failed")
    process.env.FAKE_EXIT = "0"
    process.env.FAKE_SLEEP = "20"
    await R.refreshNow()
    assert.equal((await R.stopRefresh()).stopped, true)
    assert.equal((await settle()).status, "cancelled")
    process.env.FAKE_SLEEP = "0"
  })

  it("runs on its own every day when turned on", async () => {
    await prisma.scrapeRun.deleteMany()
    as(admin)
    assert.equal(await RS.runIfDue(), false) // off
    await R.setAutoRefresh(true)
    assert.equal(await RS.runIfDue(), true) // never ran: due now
    const first = await settle()
    assert.equal(first.trigger, "schedule")
    assert.equal(await RS.runIfDue(), false)
    assert.equal(await RS.runIfDue(new Date(Date.now() + 23 * 3600_000)), false)
    assert.equal(await RS.runIfDue(new Date(Date.now() + 25 * 3600_000)), true)
    await settle()
    const st = await R.getRefreshStatus()
    assert.equal(st.everyHours, 24)
    assert.equal(st.autoRefresh, true)
    assert.ok(st.nextAt && st.nextAt > Date.now() + 23 * 3600_000)
  })

  it("offers the d3 setup only where it can run, and reports the classifier in use", async () => {
    as(admin)
    process.env.D3_URL = "http://127.0.0.1:9"   // nothing listens there
    const st = await R.getRefreshStatus()
    delete process.env.D3_URL
    assert.equal(st.classifier.d3, false)
    assert.deepEqual(st.classifier.server, { up: false, detail: "http://127.0.0.1:9" })
    // Windows and Linux PCs can run the setup; Vercel can't
    assert.equal(st.classifier.canSetup, null)
    process.env.VERCEL = "1"
    try {
      assert.match((await R.getRefreshStatus()).classifier.canSetup ?? "", /NVIDIA GPU/)
      await assert.rejects(R.setupClassifier(), /NVIDIA GPU/)
    } finally {
      delete process.env.VERCEL
    }
    as(alice)
    await rejects(R.setupClassifier())
    // once setup has finished (.venv-d3 with its python and the D3_OK marker), refreshes report d3
    const fs = await import("node:fs")
    fs.mkdirSync(".venv-d3/bin", { recursive: true })
    fs.writeFileSync(".venv-d3/bin/python", "")
    fs.writeFileSync(".venv-d3/D3_REVISION", "0123456789abcdef")
    fs.writeFileSync(".venv-d3/D3_OK", "")
    try {
      as(admin)
      const after = await R.getRefreshStatus()
      assert.deepEqual([after.classifier.d3, after.classifier.revision], [true, "0123456789abcdef"])
    } finally {
      fs.rmSync(".venv-d3", { recursive: true, force: true })
    }
  })

  it("marks a run whose process died as failed, and says when this server can't run it", async () => {
    await prisma.scrapeRun.create({ data: { trigger: "manual", pid: 2 ** 22 + 12345 } })
    await RS.sweepDeadRuns()
    assert.equal((await prisma.scrapeRun.findFirst({ orderBy: { startedAt: "desc" } }))?.status, "failed")
    // a run on another computer sharing the database (the GPU PC) is left alone: this server can't see its process
    const elsewhere = await prisma.scrapeRun.create({ data: { trigger: "setup", pid: 2 ** 22 + 12346, summary: { host: "another-pc" } } })
    await RS.sweepDeadRuns()
    assert.equal((await prisma.scrapeRun.findUnique({ where: { id: elsewhere.id } }))?.status, "running")
    process.env.VERCEL = "1"   // nor does Vercel judge any run, wherever it started
    const anywhere = await prisma.scrapeRun.create({ data: { trigger: "manual", pid: 2 ** 22 + 12347 } })
    try {
      await RS.sweepDeadRuns()
      assert.equal((await prisma.scrapeRun.findUnique({ where: { id: anywhere.id } }))?.status, "running")
    } finally {
      delete process.env.VERCEL
      await prisma.scrapeRun.deleteMany({ where: { id: { in: [elsewhere.id, anywhere.id] } } })
    }
    process.env.VERCEL = "1"
    try {
      assert.match(RS.runnerProblem() ?? "", /Vercel/)
      // on the live site, Refresh now leaves a request for the GPU PC (scraper/refresh_requests.ps1) instead
      as(alice)
      await rejects(R.refreshNow())
      as(admin)
      await prisma.scrapeRun.updateMany({ where: { status: "running" }, data: { status: "succeeded" } })
      assert.deepEqual(await R.refreshNow(), { started: false, queued: true })
      const first = (await prisma.siteMeta.findUnique({ where: { id: 1 } }))?.refreshRequestedAt
      assert.ok(first)
      assert.deepEqual(await R.refreshNow(), { started: false, queued: true })   // a second click keeps the first request
      assert.equal((await prisma.siteMeta.findUnique({ where: { id: 1 } }))?.refreshRequestedAt?.getTime(), first.getTime())
      const st = await R.getRefreshStatus()
      assert.equal(st.queue, true)
      assert.equal(st.problem, null)   // not a problem here: the button works
      assert.equal(st.requested?.at, first.getTime())
      assert.equal(st.requested?.by, admin.name ?? admin.email)
      assert.equal((await R.stopRefresh()).stopped, true)   // Cancel request
      assert.equal((await R.getRefreshStatus()).requested, null)
      // while a refresh is running, no request is left: the running one brings the board up to date
      const run = await prisma.scrapeRun.create({ data: { trigger: "schedule", status: "running", summary: { host: "GPU-PC" } } })
      assert.deepEqual(await R.refreshNow(), { started: false })
      assert.equal((await prisma.siteMeta.findUnique({ where: { id: 1 } }))?.refreshRequestedAt, null)
      await prisma.scrapeRun.delete({ where: { id: run.id } })
    } finally {
      delete process.env.VERCEL
    }
  })
})

describe("live refresh progress (the daily task on the GPU PC)", () => {
  before(async () => {
    await wipe()
    await prisma.profile.create({ data: { id: admin.id, email: admin.email, emailVerified: true, role: "admin", status: "active" } })
  })
  const token = () => process.env.SCRAPER_INGEST_TOKEN!
  const report = (body: Record<string, unknown>, t: string | null = token()) =>
    progressRoute.POST(new Request("http://localhost/api/ingest/progress", { method: "POST", body: JSON.stringify(body), headers: t ? { authorization: "Bearer " + t } : {} }))
  const progress = (extra: Record<string, unknown> = {}) => ({
    v: 1, at: Date.now(), host: "gpu-pc", step: "scrape", classifier: "",
    companies: [{ name: "Amgen", state: "running", found: null, note: "" }, { name: "Gilead Sciences", state: "waiting", found: null, note: "" }],
    classify: { done: 0, total: 0 }, outcome: null, checked: null, ...extra,
  })

  it("needs the token and a real report", async () => {
    assert.equal((await report({ event: "start", progress: progress() }, null)).status, 401)
    assert.equal((await report({ event: "start", progress: { ...progress(), step: "dancing" } })).status, 400)
  })

  it("opens a run, shows its progress on the Admin page, refuses a second one, and closes it", async () => {
    const start = await report({ event: "start", trigger: "schedule", progress: progress() })
    assert.equal(start.status, 200)
    const { runId } = await start.json()
    assert.ok(runId)
    // a second refresh can't start beside it, from the pipeline or from the Admin page
    assert.equal((await report({ event: "start", progress: progress() })).status, 409)
    as(admin)
    assert.deepEqual(await R.refreshNow().catch(() => ({ started: false })), { started: false })
    // progress shows up on the Admin page
    await report({ event: "update", runId, progress: progress({ step: "classify", companies: [{ name: "Amgen", state: "done", found: 7, note: "" }] }) })
    let st = await R.getRefreshStatus()
    assert.equal(st.runs[0].status, "running")
    assert.equal(st.runs[0].trigger, "schedule")
    assert.deepEqual([st.runs[0].progress?.step, st.runs[0].progress?.companies[0].found], ["classify", 7])
    // another server sweeping for dead runs leaves it alone while it keeps reporting
    await RS.sweepDeadRuns()
    assert.equal((await prisma.scrapeRun.findUnique({ where: { id: runId } }))?.status, "running")
    // finished: status, counts, log and the last progress are kept
    const done = await report({ event: "finish", runId, status: "succeeded", summary: { scraped: 7, publish: 3, companies: { Amgen: "ok (7)" } },
      log: "[run] finished", progress: progress({ step: "done", outcome: { publish: 3, review: 1, skip: 3, undergrad: 0, not_us: 0 } }) })
    assert.equal(done.status, 200)
    st = await R.getRefreshStatus()
    assert.equal(st.runs[0].status, "succeeded")
    assert.equal(st.runs[0].summary?.scraped, 7)
    assert.equal(st.runs[0].progress?.outcome?.publish, 3)
    assert.equal(st.runs[0].log, "[run] finished")
  })

  it("tells the pipeline to stop when staff press Stop, and fails a run that went silent", async () => {
    const { runId } = await (await report({ event: "start", progress: progress() })).json()
    as(admin)
    assert.deepEqual(await R.stopRefresh(), { stopped: true })
    const r = await (await report({ event: "update", runId, progress: progress() })).json()
    assert.equal(r.running, false)
    const silent = await prisma.scrapeRun.create({ data: { trigger: "schedule", summary: { host: "gpu-pc", progress: progress({ at: Date.now() - 11 * 60_000 }) } } })
    await RS.sweepDeadRuns()
    assert.equal((await prisma.scrapeRun.findUnique({ where: { id: silent.id } }))?.status, "failed")
  })
})

describe("public demo (DEMO_MODE=1)", () => {
  // a demo deploy is meant to have no database settings at all; even if some were set by mistake,
  // nothing real may be read or written
  it("serves made-up data only, and refuses every server action and the scraper's door", async () => {
    as(admin)   // even with a real staff session in the cookie
    process.env.DEMO_MODE = "1"
    try {
      assert.deepEqual(await A.loadState(), { mode: "preview", demo: true })
      await rejects(A.saveJobs([job("demo-1") as never]))
      const r = await ingest(new Request("http://localhost/api/ingest", { method: "POST", body: "[]", headers: { authorization: "Bearer " + "t".repeat(48) } }))
      assert.equal(r.status, 404)
      const o = await openRoute.GET(new Request("http://localhost/api/ingest/open", { headers: { authorization: "Bearer " + "t".repeat(48) } }))
      assert.equal(o.status, 404)
    } finally {
      delete process.env.DEMO_MODE
    }
    assert.equal(await prisma.posting.count({ where: { id: "demo-1" } }), 0)
  })
})
