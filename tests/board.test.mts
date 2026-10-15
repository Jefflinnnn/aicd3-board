/**
 * Job board rules that need no database: deadline countdowns, the internship start window, and how an
 * import reads it.
 *
 *   pnpm test
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { TODAY, addDays, applyBy, canStartIn, daysLeft, iso, isLive, startLabel, type Job } from "../lib/data"
import { planImport } from "../lib/importer"

const job = (over: Partial<Job> = {}): Job => ({
  id: "j1", title: "Intern - Research - Drug Metabolism - AI", company: "gilead", location: "Foster City, CA",
  locations: ["Foster City, CA"], category: "discovery", posted: iso(addDays(TODAY, -10)), deadline: "", term: "",
  mode: "Onsite", pay: "", url: "https://gilead.wd1.myworkdayjobs.com/job/R0055519", reqId: "R0055519",
  summary: "", resp: [], quals: [], ...over,
})

describe("deadlines are exclusive", () => {
  it("counts to the day before the listed date (Oct 16 seen on Oct 14: 1 day left)", () => {
    const j = job({ deadline: iso(addDays(TODAY, 2)) })
    assert.equal(daysLeft(j), 1)
    assert.equal(applyBy(j), iso(addDays(TODAY, 1)))
    assert.equal(isLive(j), true)
  })
  it("the day before the listed date is the last day", () => {
    const j = job({ deadline: iso(addDays(TODAY, 1)) })
    assert.equal(daysLeft(j), 0)
    assert.equal(isLive(j), true)
  })
  it("closed on the listed date", () => {
    assert.equal(isLive(job({ deadline: iso(TODAY) })), false)
  })
  it("rolling postings have no countdown", () => {
    assert.equal(daysLeft(job()), null)
    assert.equal(isLive(job()), true)
  })
})

describe("start window", () => {
  it("labels and matches months", () => {
    const j = job({ startFrom: 5, startTo: 7 })
    assert.equal(startLabel(j), "May to July")
    assert.deepEqual([4, 5, 7, 8].map((m) => canStartIn(j, m)), [false, true, true, false])
    assert.equal(startLabel(job({ startFrom: 6, startTo: 6 })), "June")
    assert.equal(startLabel(job()), "")
    assert.equal(canStartIn(job(), 5), false)
  })
  it("wraps the year", () => {
    const j = job({ startFrom: 11, startTo: 2 })
    assert.deepEqual([10, 11, 1, 2, 3].map((m) => canStartIn(j, m)), [false, true, true, true, false])
  })
  it("imports start_from / start_to as numbers or month names, and clears them when a later scrape drops them", () => {
    const row = { title: "Intern - Research - Drug Metabolism - AI", company: "gilead", locations: ["Foster City, CA"], category: "discovery",
      deadline: "", first_seen: iso(TODAY), url: "https://gilead.wd1.myworkdayjobs.com/job/R0055519", req_id: "R0055519",
      description: "Apply AI to DMPK data.", responsibilities: ["Build models"], qualifications: ["PhD student"] }
    const first = planImport(JSON.stringify({ postings: [{ ...row, start_from: 5, start_to: "July" }] }), [], false)
    assert.equal(first.errors.length, 0)
    const added = [...first.add, ...first.stage][0]
    assert.deepEqual([added.startFrom, added.startTo], [5, 7])
    const existing = { ...added, id: "j1" }
    const again = planImport(JSON.stringify({ postings: [{ ...row, start_from: "May", start_to: 7 }] }), [existing], false)
    assert.equal(again.unchanged, 1)
    const dropped = planImport(JSON.stringify({ postings: [row] }), [existing], false)
    assert.equal(dropped.update.length, 1)
    assert.equal(dropped.update[0].startFrom, undefined)
  })
  it("a category fixed by the scraper updates the posting", () => {
    const existing = { ...job({ category: "tech", posted: iso(TODAY) }), id: "j1" }
    const row = { title: existing.title, company: "gilead", locations: ["Foster City, CA"], category: "discovery", deadline: "",
      first_seen: iso(TODAY), url: existing.url, req_id: "R0055519", description: "", responsibilities: [], qualifications: [] }
    const plan = planImport(JSON.stringify({ postings: [row] }), [existing], false)
    assert.equal(plan.update[0]?.category, "discovery")
  })
})
