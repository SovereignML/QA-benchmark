import type { Pool } from "pg"

// Columns this tool writes, per table. Mirrors atlasagents-app's
// src/db/schema.ts (users, teams, memberships) and src/lib/team.ts
// getOrCreatePersonalTeam, plus the verification token from
// src/app/api/auth/register/route.ts.
const WRITES: Record<string, string[]> = {
  User: ["id", "name", "email", "emailVerified", "hashedPassword", "freeAgentLimit", "createdAt", "updatedAt"],
  Team: ["id", "name", "ownerId"],
  Membership: ["teamId", "userId", "role"],
  // The pending email-verification token a real signup leaves behind
  // (src/lib/email-verification.ts issueAndSendVerification).
  VerificationToken: ["identifier", "token", "expires"],
}

// Tables that must exist for this to be an atlasagents-app database at all.
// Checked so a tunnel to the wrong Postgres is refused before any write.
const FINGERPRINT = ["User", "Team", "Membership", "VerificationToken", "Instance", "Wallet", "RateLimitBucket"]

export type SchemaReport = {
  ok: boolean
  problems: string[]
  database: string
  userCount: number
  serverVersion: string
}

export async function checkSchema(pool: Pool): Promise<SchemaReport> {
  const problems: string[] = []

  const { rows: tables } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [FINGERPRINT],
  )
  const present = new Set(tables.map((t) => t.table_name))
  const missing = FINGERPRINT.filter((t) => !present.has(t))
  if (missing.length) {
    problems.push(
      `This is not the atlasagents-app database — missing tables: ${missing.join(", ")}.`,
    )
  }

  const { rows: cols } = await pool.query<{
    table_name: string
    column_name: string
    is_nullable: "YES" | "NO"
    column_default: string | null
  }>(
    `SELECT table_name, column_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [Object.keys(WRITES)],
  )

  for (const [table, written] of Object.entries(WRITES)) {
    const tableCols = cols.filter((c) => c.table_name === table)
    if (tableCols.length === 0) continue // reported above
    const names = new Set(tableCols.map((c) => c.column_name))
    for (const w of written) {
      if (!names.has(w)) problems.push(`${table}.${w} no longer exists.`)
    }
    // A NOT NULL column with no default that we don't write would make every
    // insert fail — or, worse, mean the app now expects data we don't supply.
    for (const c of tableCols) {
      if (c.is_nullable === "NO" && c.column_default === null && !written.includes(c.column_name)) {
        problems.push(`${table}.${c.column_name} is NOT NULL with no default, and this tool doesn't set it.`)
      }
    }
  }

  const { rows: meta } = await pool.query<{ db: string; v: string }>(
    `SELECT current_database() AS db, current_setting('server_version') AS v`,
  )
  let userCount = 0
  if (present.has("User")) {
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM "User"`)
    userCount = Number(rows[0].n)
  }

  return {
    ok: problems.length === 0,
    problems,
    database: meta[0].db,
    userCount,
    serverVersion: meta[0].v,
  }
}
