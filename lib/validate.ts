/** Returns a normalized https URL, or null when the text is not a usable web address. */
export function normalizeUrl(raw: string): string | null {
  const t = raw.trim()
  if (!t || /\s/.test(t)) return null
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : "https://" + t)
    if (u.protocol !== "https:" && u.protocol !== "http:") return null
    // a real host: labels separated by dots, ending in a 2+ letter TLD
    if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(u.hostname)) return null
    return u.toString()
  } catch {
    return null
  }
}

export const isEmail = (raw: string) => /^[^\s@]+@([a-z0-9-]+\.)+[a-z]{2,}$/i.test(raw.trim())
