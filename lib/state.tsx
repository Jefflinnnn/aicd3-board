"use client"

import { createContext, useContext } from "react"
import type { Backend } from "./backend"
import type { Job } from "./data"

export type ThemePref = "system" | "light" | "dark"
export type SortKey = "title" | "company" | "location" | "deadline" | "posted"
export interface SortSpec { key: SortKey; dir: 1 | -1 }
export const SORT_PRESETS: { id: string; label: string; sort: SortSpec }[] = [
  { id: "deadline-asc", label: "Soonest deadline", sort: { key: "deadline", dir: 1 } },
  { id: "deadline-desc", label: "Latest deadline", sort: { key: "deadline", dir: -1 } },
  { id: "posted-desc", label: "Newest first seen", sort: { key: "posted", dir: -1 } },
  { id: "posted-asc", label: "Oldest first seen", sort: { key: "posted", dir: 1 } },
  { id: "company-asc", label: "Company A to Z", sort: { key: "company", dir: 1 } },
  { id: "title-asc", label: "Title A to Z", sort: { key: "title", dir: 1 } },
]
export interface Settings {
  theme: ThemePref
  sidebarCollapsed: boolean
  compact: boolean
  /** the animated colour backdrop behind each page */
  backdrop: boolean
  soonDays: number
  sort: string // a SORT_PRESETS id
  home: string // "" = no preference
}
export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  sidebarCollapsed: false,
  compact: true,
  backdrop: true,
  soonDays: 14,
  sort: "deadline-asc",
  home: "San Francisco, CA",
}

export type StatusFilter = "live" | "expired" | "all"
export type DeadlineFilter = "" | "week" | "14" | "30" | "rolling"
export interface JobFilters {
  company: string[]
  location: string[]
  category: string[]
  type: string[]
  deadline: DeadlineFilter
  status: StatusFilter
}
export const EMPTY_FILTERS: JobFilters = { company: [], location: [], category: [], type: [], deadline: "", status: "live" }

export type BoardTab = "todo" | "saved" | "done"

export interface AppState extends Backend {
  applied: Set<string>
  saved: Set<string>
  toggleApplied: (id: string) => void
  /** First seen after this person's previous visit. */
  isNew: (j: Job) => boolean
  settings: Settings
  setSettings: (patch: Partial<Settings>) => void
  dark: boolean
  openJob: (id: string) => void
  openReport: (jobId?: string) => void
  go: (page: string, jobFilter?: Partial<JobFilters>, tab?: BoardTab) => void
  pendingFilter: Partial<JobFilters> | null
  /** the job board tab a link asked for */
  pendingTab: BoardTab | null
  clearPendingFilter: () => void
  openCommand: () => void
}

export const AppCtx = createContext<AppState | null>(null)
export const useApp = () => {
  const v = useContext(AppCtx)
  if (!v) throw new Error("AppCtx missing")
  return v
}
