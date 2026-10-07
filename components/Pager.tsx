"use client"

import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

/** Rows-per-page picker, range readout and numbered pages. `page` is 1-based and already clamped. */
export function Pager({ page, pageSize, total, sizes, onPage, onPageSize, id }: { page: number; pageSize: number; total: number; sizes: number[]; onPage: (p: number) => void; onPageSize: (n: number) => void; id: string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const nums: (number | "gap")[] = (() => {
    if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1)
    const arr = [...new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages))].sort((a, b) => a - b)
    const out: (number | "gap")[] = []
    arr.forEach((n, i) => {
      if (i && n - arr[i - 1] > 1) out.push("gap")
      out.push(n)
    })
    return out
  })()
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3 text-sm">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span id={id}>Rows per page</span>
        <Select value={String(pageSize)} onValueChange={(v) => onPageSize(Number(v))}>
          <SelectTrigger className="h-8 w-[76px]" aria-labelledby={id}><SelectValue /></SelectTrigger>
          <SelectContent>{sizes.map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}</SelectContent>
        </Select>
        <span className="tabular-nums">{total ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}` : "0 of 0"}</span>
      </div>
      <nav aria-label="Pages" className="flex items-center gap-1">
        <Button variant="ghost" size="icon" className="size-8" disabled={page === 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft className="size-4" /></Button>
        {nums.map((n, i) =>
          n === "gap" ? (
            <span key={"g" + i} className="px-1 text-muted-foreground">…</span>
          ) : (
            <Button key={n} variant={n === page ? "secondary" : "ghost"} size="icon" className="size-8 tabular-nums" aria-current={n === page ? "page" : undefined} onClick={() => onPage(n)}>
              {n}
            </Button>
          )
        )}
        <Button variant="ghost" size="icon" className="size-8" disabled={page === pages} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight className="size-4" /></Button>
      </nav>
    </div>
  )
}
