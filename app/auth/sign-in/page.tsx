import type { Metadata } from "next"
import { Suspense } from "react"
import { signInDomains } from "@/lib/domains"
import { SignIn } from "./SignIn"

export const metadata: Metadata = { title: "Sign in | AICD3 Job Board" }
// reads SIGN_IN_EMAIL_DOMAINS at request time
export const dynamic = "force-dynamic"

export default function Page() {
  return (
    <Suspense>
      <SignIn domains={signInDomains()} />
    </Suspense>
  )
}
