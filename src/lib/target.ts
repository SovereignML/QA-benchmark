// The one and only target. This tool seeds the production atlasagents-app and
// refuses anything else. These values are hardcoded on purpose.

export const TARGET_HOST = "app.atlasagents.dev"
export const LOGIN_URL = `https://${TARGET_HOST}/login`

// AutoSignUp runs on the prod server next to atlasagents-app, where Postgres
// listens on 127.0.0.1 (scripts/bootstrap-pg.sh). It can also run on a laptop
// through an SSH tunnel (ssh -N -L 5433:127.0.0.1:5432 <prod-host>). Either
// way the DB host is local; anything else is refused.
export const LOCAL_DB_HOSTS = new Set(["127.0.0.1", "localhost", "::1"])

export const DEFAULT_DAILY_CAP = 300
export const MAX_DAILY_CAP = 5000
export const MAX_JOB_SIZE = 5000
export const MAX_POOL_SIZE = 50000
export const MAX_WINDOW_DAYS = 31
// atlasagents-app's verification token lives 24h (src/lib/email-verification.ts
// TTL_MS). A real user can't verify later than that, so neither can ours.
export const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000
export const MAX_VERIFY_DELAY_MIN = 23 * 60

export function timeZone(): string {
  return process.env.AUTOSIGNUP_TZ || "Asia/Dhaka"
}

/** Calendar day (YYYY-MM-DD) of `d` in the configured time zone. */
export function dayKey(d: Date | string | number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(d))
}

/**
 * Validates DATABASE_URL. Returns the parsed URL or throws an Error whose
 * message is safe to show (never echoes the password).
 */
export function assertLocalDbUrl(raw: string | undefined): URL {
  if (!raw) throw new Error("DATABASE_URL is not set in AutoSignUp's .env.")
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error("DATABASE_URL is not a valid URL.")
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must start with postgresql://")
  }
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (!LOCAL_DB_HOSTS.has(host)) {
    throw new Error(
      `DB host "${host}" refused. Run AutoSignUp on the prod server (127.0.0.1) or through an SSH tunnel.`,
    )
  }
  if (!url.pathname || url.pathname === "/") throw new Error("DATABASE_URL is missing the database name.")
  return url
}

export function redactUrl(url: URL): string {
  const copy = new URL(url.toString())
  if (copy.password) copy.password = "****"
  copy.search = ""
  return copy.toString()
}
