import { NextResponse } from "next/server"

// The server binds to 127.0.0.1, but a page on some other site open in the
// same browser could still POST to it. Reject any request whose Origin isn't
// this app.
export function guard(req: Request): NextResponse | null {
  const host = req.headers.get("host") ?? ""
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
    return NextResponse.json({ error: "Local use only." }, { status: 403 })
  }
  const origin = req.headers.get("origin")
  if (req.method !== "GET" && origin && new URL(origin).host !== host) {
    return NextResponse.json({ error: "Cross-origin request refused." }, { status: 403 })
  }
  return null
}

export function fail(err: unknown, status = 400) {
  return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status })
}
