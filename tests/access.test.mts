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
process.env.ALLOWED_EMAIL_DOMAINS = "school.edu"
process.env.SCRAPER_INGEST_TOKEN = "t".repeat(48)

type FakeUser = { id: string; email: string; emailVerified: boolean; name: string }
let current: FakeUser | null = null
;(globalThis as Record<string, unknown>).__neonAuth = {
  getSession: async () => ({ data: current ? { user: current, session: { id: "s" } } : null, error: null }),
}
const as = (u: FakeUser | null) => { current = u }
const user = (id: string, email: string, emailVerified = true): FakeUser => ({ id, email, emailVerified, name: id })

const A = await import("../lib/actions")
const P = await import("../lib/people-actions")
const { db } = await import("../lib/server/db")
const { POST: ingest } = await import("../app/api/ingest/route")
const prisma = db()

const job = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: "Data Science Intern", company: "amgen", location: "Thousand Oaks, CA", locations: ["Thousand Oaks, CA"],
  category: "tech", posted: "2026-10-01", deadline: "2026-12-01", term: "Summer 2027", mode: "Onsite", pay: "$40/hr",
  url: "https://careers.amgen.com/job/" + id, summary: "x".repeat(120), resp: ["Build models"], quals: ["Python"], ...extra,
})
const rejects = (p: Promise<unknown>, re = /permission|approval|sign in|access/i) => assert.rejects(p, re)

async function wipe() {
  for (const t of ["JobStatus", "JobNote", "CompanyRequest", "IssueReport", "Posting", "AccessGrant", "Profile", "SiteMeta", "AuditLog"])
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
