import { NextResponse, type NextRequest } from "next/server"
import { checkAccess } from "@/lib/access"

// Runs before every request — page, API and static assets alike — so nothing
// is served to a host or user that checkAccess refuses.
export function proxy(req: NextRequest) {
  const r = checkAccess(req.headers.get("host"), req.headers.get("authorization"))
  if (r.ok) return NextResponse.next()
  return new NextResponse(r.message, {
    status: r.status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...(r.challenge ? { "www-authenticate": 'Basic realm="AutoSignUp", charset="UTF-8"' } : {}),
    },
  })
}
