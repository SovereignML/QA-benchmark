import { createHash, randomBytes } from "node:crypto"
import { createId } from "@paralleldrive/cuid2"
import type { Pool } from "pg"
import { hashPassword } from "./password"
import type { JobUser } from "./store"
import { VERIFY_TOKEN_TTL_MS } from "./target"

// The two prod writes, each mirroring atlasagents-app exactly.
//
// Timestamps: the app's columns are `timestamp without time zone`. Columns the
// app leaves to Postgres (`createdAt`, `updatedAt` on insert) we also leave to
// Postgres via their defaults. Columns the app sets from JS (`emailVerified`,
// `updatedAt` on update, `VerificationToken.expires`) Drizzle writes as UTC
// wall-clock strings — so do we, via utc().

/** Drizzle's serialization of a Date for a `timestamp` (no tz) column. */
function utc(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "")
}

const verifyIdentifier = (email: string) => `email-verify:${email.toLowerCase()}`

export type SignupResult =
  | { kind: "created"; userId: string; teamId: string; signedUpAt: string }
  | { kind: "exists" }

/**
 * What POST /api/auth/register leaves in the DB for a credentials signup on
 * the canonical host, minus the email send / PostHog / ad conversion:
 *   User        name, email, bcrypt(10) hash; emailVerified NULL;
 *               every other column at its default
 *   Team        "<name>'s Team", owned by the user   (getOrCreatePersonalTeam)
 *   Membership  owner
 *   VerificationToken  email-verify:<email>, sha256 of a random 32-byte token, +24h
 *
 * One exception: `freeAgentLimit` is set when the job asks for it (default 0)
 * so a test account can never start a billed VM.
 */
export async function signUp(pool: Pool, u: JobUser, freeAgentLimit: number | null): Promise<SignupResult> {
  const hash = await hashPassword(u.password)
  const userId = createId()
  const teamId = createId()
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    // Case-insensitive guard: the app's unique index is on the raw email.
    const dup = await client.query(`SELECT 1 FROM "User" WHERE lower(email) = $1 LIMIT 1`, [u.email.toLowerCase()])
    if (dup.rowCount) {
      await client.query("ROLLBACK")
      return { kind: "exists" }
    }
    const ins = await client.query(
      `INSERT INTO "User" (id, name, email, "hashedPassword", "freeAgentLimit")
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [userId, u.name, u.email, hash, freeAgentLimit],
    )
    if (ins.rowCount === 0) {
      await client.query("ROLLBACK")
      return { kind: "exists" }
    }
    await client.query(`INSERT INTO "Team" (id, name, "ownerId") VALUES ($1, $2, $3)`, [
      teamId,
      `${u.name}'s Team`,
      userId,
    ])
    await client.query(
      `INSERT INTO "Membership" ("teamId", "userId", role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`,
      [teamId, userId],
    )
    const identifier = verifyIdentifier(u.email)
    await client.query(`DELETE FROM "VerificationToken" WHERE identifier = $1`, [identifier])
    await client.query(`INSERT INTO "VerificationToken" (identifier, token, expires) VALUES ($1, $2, $3)`, [
      identifier,
      createHash("sha256").update(randomBytes(32).toString("hex")).digest("hex"),
      utc(new Date(Date.now() + VERIFY_TOKEN_TTL_MS)),
    ])
    await client.query("COMMIT")
    return { kind: "created", userId, teamId, signedUpAt: new Date().toISOString() }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export type VerifyResult = { kind: "verified"; verifiedAt: string } | { kind: "gone" } | { kind: "already" }

/**
 * What GET /api/auth/verify-email does on a valid link: set emailVerified,
 * drop the token. (Drizzle's $onUpdate also bumps updatedAt.)
 */
export async function verifyEmail(pool: Pool, u: JobUser): Promise<VerifyResult> {
  if (!u.userId) return { kind: "gone" }
  const now = new Date()
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const res = await client.query<{ v: Date | null }>(`SELECT "emailVerified" AS v FROM "User" WHERE id = $1 FOR UPDATE`, [
      u.userId,
    ])
    if (res.rowCount === 0) {
      await client.query("ROLLBACK")
      return { kind: "gone" }
    }
    if (res.rows[0].v !== null) {
      await client.query("ROLLBACK")
      return { kind: "already" }
    }
    await client.query(`UPDATE "User" SET "emailVerified" = $2, "updatedAt" = $2 WHERE id = $1`, [u.userId, utc(now)])
    await client.query(`DELETE FROM "VerificationToken" WHERE identifier = $1`, [verifyIdentifier(u.email)])
    await client.query("COMMIT")
    return { kind: "verified", verifiedAt: now.toISOString() }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
