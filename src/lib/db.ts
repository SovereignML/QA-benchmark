import { Pool } from "pg"
import { checkSchema, type SchemaReport } from "./schema-check"
import { assertLocalDbUrl, redactUrl } from "./target"

// One pool per process, from DATABASE_URL in AutoSignUp's own .env. Kept on
// globalThis so dev-mode hot reloads don't leak connections.
type Conn = { pool: Pool; display: string; database: string }
const g = globalThis as unknown as { __autosignupConn?: Conn; __autosignupSchema?: { at: number; report: SchemaReport } }

export function getConn(): Conn {
  if (g.__autosignupConn) return g.__autosignupConn
  const url = assertLocalDbUrl(process.env.DATABASE_URL)
  // pg ignores Drizzle's ?schema=public; strip it so it isn't sent as a
  // startup parameter.
  url.searchParams.delete("schema")
  const pool = new Pool({
    connectionString: url.toString(),
    max: 4,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 30000,
    statement_timeout: 60000,
  })
  pool.on("error", () => {})
  g.__autosignupConn = { pool, display: redactUrl(url), database: url.pathname.slice(1) }
  return g.__autosignupConn
}

/**
 * Schema check, cached for a minute. Every write path calls this first and
 * refuses to run if the target isn't a healthy atlasagents-app database.
 */
export async function verifiedPool(force = false): Promise<Pool> {
  const { pool } = getConn()
  const cached = g.__autosignupSchema
  if (!force && cached && Date.now() - cached.at < 60_000 && cached.report.ok) return pool
  const report = await checkSchema(pool)
  g.__autosignupSchema = { at: Date.now(), report }
  if (!report.ok) throw new Error(`Schema check failed: ${report.problems.join(" ")}`)
  return pool
}

export async function dbStatus(): Promise<
  { ok: true; display: string; report: SchemaReport } | { ok: false; error: string }
> {
  try {
    const c = getConn()
    const report = await checkSchema(c.pool)
    g.__autosignupSchema = { at: Date.now(), report }
    return { ok: true, display: c.display, report }
  } catch (err) {
    const code = (err as { code?: string }).code
    const msg =
      code === "ECONNREFUSED"
        ? "Postgres isn't reachable at DATABASE_URL (is it running / is the tunnel open?)."
        : code === "28P01"
          ? "Postgres rejected the username or password in DATABASE_URL."
          : (err as Error).message
    return { ok: false, error: msg }
  }
}
