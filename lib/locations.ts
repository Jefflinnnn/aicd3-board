/**
 * Turns the location formats career sites use into the board's "City, ST" form, so places line up
 * with the map and the distance sort:
 *
 *   "US - New Jersey - Rahway"                -> "Rahway, NJ"          (Workday)
 *   "USA - California - South San Francisco"  -> "South San Francisco, CA"
 *   "US-NJ-Rahway"                            -> "Rahway, NJ"
 *   "US - Frederick - MD"                     -> "Frederick, MD"       (AstraZeneca)
 *   "Princeton - NJ - US"                     -> "Princeton, NJ"       (Bristol Myers Squibb)
 *   "US, Indianapolis IN"                     -> "Indianapolis, IN"    (Lilly)
 *   "Redwood City, California, United States" -> "Redwood City, CA"    (Greenhouse)
 *   "Columbus, United States, Ohio"           -> "Columbus, OH"        (SuccessFactors)
 *   "North Chicago IL"                        -> "North Chicago, IL"   (AbbVie)
 *   "United States - Remote", "Remote - US"   -> "Remote (US)"
 *   "Germany - Ingelheim"                     -> "Ingelheim, Germany"
 *
 * Anything it doesn't recognise comes back unchanged. scraper/pharma_internships.py has the same
 * rules in Python (normalize_location); keep the two in step.
 */
const STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA",
  "puerto rico": "PR", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN",
  texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY",
}
const CODES = new Set(Object.values(STATES))
const US = /^(us|usa|u\.s\.a?\.?|united states( of america)?)$/i

const stateCode = (s: string): string | null => {
  const t = s.trim()
  if (CODES.has(t.toUpperCase()) && t.length === 2) return t.toUpperCase()
  return STATES[t.toLowerCase()] ?? null
}
const tidy = (s: string) => s.replace(/\s+/g, " ").trim()
/** "SLEEPY HOLLOW" -> "Sleepy Hollow"; mixed-case names are left alone */
const city = (s: string) => (s.length > 3 && s === s.toUpperCase() && /[A-Z]/.test(s) ? s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : s)

export function normalizeLocation(raw: string): string {
  const loc = tidy(raw || "")
  if (!loc) return loc

  // remote, US
  if (/\bremote\b/i.test(loc) && (/\b(us|usa|united states)\b/i.test(loc) || /^remote$/i.test(loc))) return "Remote (US)"

  // "US, Indianapolis IN", "US: South San Francisco"
  const pre = /^(?:US|USA|United States(?: of America)?)\s*[,:]\s*(.+)$/i.exec(loc)
  if (pre) return normalizeLocation(pre[1])

  // "US - New Jersey - Rahway", "USA - CA - South San Francisco - Gateway", "US-NJ-Rahway"
  const dashed = loc.split(/\s+-\s+|\s*–\s*/).map(tidy).filter(Boolean)
  const parts = dashed.length >= 2 ? dashed : /^(US|USA)-[A-Za-z]{2}-/.test(loc) ? loc.split("-").map(tidy) : dashed
  if (parts.length >= 3 && US.test(parts[0])) {
    const st = stateCode(parts[1])
    if (st) return `${city(parts[2])}, ${st}`
  }
  if (parts.length === 3 && US.test(parts[0]) && stateCode(parts[2])) return `${city(parts[1])}, ${stateCode(parts[2])}` // "US - Frederick - MD"
  if (parts.length === 3 && US.test(parts[2]) && stateCode(parts[1])) return `${city(parts[0])}, ${stateCode(parts[1])}` // "Princeton - NJ - US"
  if (parts.length === 2 && US.test(parts[0])) return parts[1] // "US - Boston" or just a state
  // "Germany - Ingelheim", "UK - Hertfordshire - Stevenage": city last, country first
  if (parts.length >= 2 && !US.test(parts[0]) && !/,/.test(loc) && /^[A-Za-z .'()]+$/.test(parts[0])) {
    return `${parts[parts.length - 1]}, ${parts[0]}`
  }

  // comma forms
  const c = loc.split(",").map(tidy).filter(Boolean)
  if (c.length >= 2) {
    // "Redwood City, California, United States" / "Rahway, NJ, USA" / "Rahway, NJ"
    if (stateCode(c[1]) && (c.length === 2 || US.test(c[2]))) return `${city(c[0])}, ${stateCode(c[1])}`
    // "Columbus, United States, Ohio"
    if (c.length === 3 && US.test(c[1]) && stateCode(c[2])) return `${city(c[0])}, ${stateCode(c[2])}`
    // "Cambridge, United States"
    if (c.length === 2 && US.test(c[1])) return c[0]
    // "CA, Santa Clara" (NVIDIA's "US, CA, Santa Clara" once the country is gone): state first, city last
    if (c.length === 2 && stateCode(c[0]) && !stateCode(c[1])) return `${city(c[1])}, ${stateCode(c[0])}`
    return loc
  }

  // "North Chicago IL"
  const m = /^(.+?)\s+([A-Za-z]{2})$/.exec(loc)
  if (m && CODES.has(m[2].toUpperCase()) && /[a-z]/.test(m[1])) return `${m[1]}, ${m[2].toUpperCase()}`
  return loc
}
