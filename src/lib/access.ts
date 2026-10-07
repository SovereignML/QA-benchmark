import { timingSafeEqual } from "node:crypto"

// Who may reach AutoSignUp at all.
//
// - Always: localhost (SSH tunnel, or curl on the box).
// - Optionally: one public host behind a reverse proxy, e.g.
//   AUTOSIGNUP_PUBLIC_HOST=qa.atlasagents.dev — and only if
//   AUTOSIGNUP_BASIC_AUTH=user:password is also set. A public host with no
//   password is refused outright: this app creates prod users and shows their
//   passwords.

const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

// Read env by dynamic key: Next inlines literal `process.env.X` into the proxy
// bundle at BUILD time, which would freeze these to whatever the build saw.
const env = (key: string): string | undefined => process.env[key]

export function publicHost(): string | null {
  const h = env("AUTOSIGNUP_PUBLIC_HOST")?.trim().toLowerCase()
  return h ? h : null
}

function basicAuth(): { user: string; pass: string } | null {
  const raw = env("AUTOSIGNUP_BASIC_AUTH") ?? ""
  const i = raw.indexOf(":")
  if (i < 1 || i === raw.length - 1) return null
  return { user: raw.slice(0, i), pass: raw.slice(i + 1) }
}

export type HostKind = "local" | "public" | "refused"

export function hostKind(hostHeader: string | null): HostKind {
  const host = (hostHeader ?? "").trim().toLowerCase()
  if (LOCAL.test(host)) return "local"
  const pub = publicHost()
  if (pub && (host === pub || host === `${pub}:443`)) return "public"
  return "refused"
}

function same(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export type AccessResult =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 503; message: string; challenge?: boolean }

/**
 * The full access decision for one request. Basic auth, when configured,
 * applies on every host (tunnel included) so there is one rule to reason about.
 */
export function checkAccess(hostHeader: string | null, authorization: string | null): AccessResult {
  const kind = hostKind(hostHeader)
  if (kind === "refused") return { ok: false, status: 403, message: "Host not allowed." }

  const creds = basicAuth()
  if (kind === "public" && !creds) {
    return {
      ok: false,
      status: 503,
      message: "Public access needs AUTOSIGNUP_BASIC_AUTH=user:password in AutoSignUp's .env.",
    }
  }
  if (!creds) return { ok: true }

  const m = /^Basic\s+(.+)$/i.exec(authorization ?? "")
  if (m) {
    const decoded = Buffer.from(m[1], "base64").toString("utf8")
    const i = decoded.indexOf(":")
    if (i > 0 && same(decoded.slice(0, i), creds.user) && same(decoded.slice(i + 1), creds.pass)) {
      return { ok: true }
    }
  }
  return { ok: false, status: 401, message: "Sign in required.", challenge: true }
}
