/**
 * Which email addresses can use the job board.
 *
 *   SIGN_IN_EMAIL_DOMAINS        who may sign in at all (default: ucsf.edu). Everyone else is refused,
 *                                both when asking for a code and on every request after sign-in.
 *   AUTO_APPROVE_EMAIL_DOMAINS   optional: verified addresses here become active students on first
 *                                sign-in. Leave empty to have staff approve each new account.
 *
 * A domain also covers its subdomains (ucsf.edu matches someone@med.ucsf.edu).
 */
const parse = (raw: string | undefined) =>
  (raw || "").split(",").map((s) => s.trim().toLowerCase().replace(/^@/, "")).filter(Boolean)

export const signInDomains = () => {
  const list = parse(process.env.SIGN_IN_EMAIL_DOMAINS)
  return list.length ? list : ["ucsf.edu"]
}

// ALLOWED_EMAIL_DOMAINS is the older name for this setting
export const autoApproveDomains = () => parse(process.env.AUTO_APPROVE_EMAIL_DOMAINS ?? process.env.ALLOWED_EMAIL_DOMAINS)

export function inDomains(email: string, domains: string[]) {
  const d = (email.trim().toLowerCase().split("@")[1] || "")
  return !!d && domains.some((a) => d === a || d.endsWith("." + a))
}

export const canSignIn = (email: string) => inDomains(email, signInDomains())

/** "@ucsf.edu" or "@ucsf.edu or @example.org", for messages. */
export const domainsLabel = (domains: string[]) =>
  domains.map((d) => "@" + d).join(domains.length > 2 ? ", " : " or ").replace(/, ([^,]*)$/, ", or $1")
