"use client"

/**
 * The backdrop behind the top of every page: a still, quiet dot grid like the ones on YC startup
 * sites. It fades out toward the edges and scrolls away with the page, so headings stay crisp.
 */
export function Backdrop() {
  return (
    <div aria-hidden className="backdrop pointer-events-none absolute inset-x-0 top-0 -z-10 h-[760px] overflow-hidden">
      <div className="backdrop-dots" />
    </div>
  )
}
