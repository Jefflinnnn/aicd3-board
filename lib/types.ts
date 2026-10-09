import type { BinItem, Category, CompanyRequest, IssueReport, Job, StagedJob } from "./data"

export type Mode = "loading" | "cloud" | "preview" | "signedout" | "pending" | "blocked" | "unavailable"
export type MyStatus = "saved" | "applied"
export type Role = "student" | "staff" | "admin"
export interface DashLayout { order: string[]; hidden: string[] }
export interface Mine {
  status: Record<string, MyStatus>
  notes: Record<string, string>
  lastVisit?: number
  /** this person's dashboard arrangement: section order and the ones they hid */
  layout?: DashLayout
}
export interface Meta {
  customCats: Category[]
  lastUpdated?: number
  lastImport?: { at: number; added: number; updated: number; closed: number }
}
export interface InboxDoc {
  uid: string
  requests: CompanyRequest[]
  reports: IssueReport[]
}
export interface Me {
  id: string | null
  canEdit: boolean
  role: Role
  name: string | null
  email: string | null
}

/** Everything the app needs on load, scoped to what this person may see. */
export type LoadResult =
  | { mode: "preview" | "signedout" | "unavailable" }
  | { mode: "pending" | "blocked"; me: Me }
  | {
      mode: "cloud"
      me: Me
      jobs: Job[]
      meta: Meta
      mine: Mine
      prevVisit: number | null
      myInbox: { requests: CompanyRequest[]; reports: IssueReport[] }
      /** staff only */
      staff?: { bin: BinItem[]; staged: StagedJob[]; inbox: InboxDoc[]; names: Record<string, string> }
    }

export interface Person {
  id: string
  email: string
  emailVerified: boolean
  name: string | null
  role: Role
  status: "pending" | "active" | "blocked"
  createdAt: number
}
export interface Invite { email: string; role: Role; createdAt: number }
