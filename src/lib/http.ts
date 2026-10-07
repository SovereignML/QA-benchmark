import { NextResponse } from "next/server"
import { checkAccess } from "./access"

// Second line of defence behind src/proxy.ts (same rules), plus: refuse
// cross-origin writes, so a page on another site open in the same browser
// can't drive this API with the operator's credentials.
export function guard(req: Request): NextResponse | null {
  const r = checkAccess(req.headers.get("host"), req.headers.get("authorization"))
  if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.status })
  const host = req.headers.get("host") ?? ""
  const origin = req.headers.get("origin")
  if (req.method !== "GET" && origin) {
    let originHost = ""
    try {
      originHost = new URL(origin).host
    } catch {}
    // Behind a TLS-terminating proxy the browser says https://qa…, the
    // proxied Host may carry :443 or nothing — compare hostnames only.
    if (originHost.replace(/:\d+$/, "") !== host.replace(/:\d+$/, "")) {
      return NextResponse.json({ error: "Cross-origin request refused." }, { status: 403 })
    }
  }
  return null
}

export function fail(err: unknown, status = 400) {
  return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status })
}
