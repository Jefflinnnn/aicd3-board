"use client"

import { createAuthClient } from "@neondatabase/auth/next"

/** Browser-side auth: talks to this app's /api/auth route, which proxies to Neon Auth. */
export const authClient = createAuthClient()
