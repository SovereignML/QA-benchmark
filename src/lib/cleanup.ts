import type { Pool } from "pg"
import { getPool, jobLog, loadJob, saveJob, savePool, withLock } from "./store"
import { TARGET_HOST } from "./target"

// Things a test account may have created after it was seeded that deleting the
// User row would cascade away while the real-world resource keeps running (and
// billing): a VM, a BYOS server, a Stripe subscription, wallet credit. If any
// exist, that user is held back and listed so it can be handled by hand.
const BLOCKERS: { label: string; sql: string }[] = [
  { label: "agent instances", sql: `SELECT "userId" AS uid, count(*)::int AS n FROM "Instance" WHERE "userId" = ANY($1) GROUP BY 1` },
  { label: "BYOS servers", sql: `SELECT "userId" AS uid, count(*)::int AS n FROM "ByosServer" WHERE "userId" = ANY($1) GROUP BY 1` },
  { label: "subscriptions", sql: `SELECT "userId" AS uid, count(*)::int AS n FROM "Subscription" WHERE "userId" = ANY($1) GROUP BY 1` },
  { label: "wallet balance", sql: `SELECT "userId" AS uid, count(*)::int AS n FROM "Wallet" WHERE "userId" = ANY($1) AND balance <> 0 GROUP BY 1` },
  {
    label: "other members in their team",
    sql: `SELECT t."ownerId" AS uid, count(*)::int AS n
            FROM "Team" t JOIN "Membership" m ON m."teamId" = t.id
           WHERE t."ownerId" = ANY($1) AND m."userId" <> t."ownerId" GROUP BY 1`,
  },
]

type Ref = { userId: string; email: string }

export type CleanupPlan = {
  jobId: string
  pendingToCancel: number
  alreadyGone: string[]
  mismatched: { userId: string; recordedEmail: string; currentEmail: string }[]
  blocked: (Ref & { reasons: string[] })[]
  deletable: Ref[]
  teams: number
  memberships: number
  tokens: number
}

export async function planCleanup(pool: Pool, jobId: string): Promise<CleanupPlan> {
  const job = await loadJob(jobId)
  const created = job.users.filter((u) => u.userId && (u.state === "signed-up" || u.state === "verified" || u.state === "failed"))
  const ids = created.map((u) => u.userId!)

  const { rows: live } = await pool.query<{ id: string; email: string }>(`SELECT id, email FROM "User" WHERE id = ANY($1)`, [ids])
  const liveById = new Map(live.map((r) => [r.id, r.email]))

  const present: Ref[] = []
  const alreadyGone: string[] = []
  const mismatched: CleanupPlan["mismatched"] = []
  for (const u of created) {
    const cur = liveById.get(u.userId!)
    if (cur === undefined) alreadyGone.push(u.email)
    else if (cur.toLowerCase() !== u.email.toLowerCase())
      mismatched.push({ userId: u.userId!, recordedEmail: u.email, currentEmail: cur })
    else present.push({ userId: u.userId!, email: u.email })
  }

  const reasons = new Map<string, string[]>()
  const presentIds = present.map((u) => u.userId)
  for (const b of BLOCKERS) {
    const { rows } = await pool.query<{ uid: string; n: number }>(b.sql, [presentIds])
    for (const r of rows) reasons.set(r.uid, [...(reasons.get(r.uid) ?? []), `${r.n} ${b.label}`])
  }
  const blocked = present.filter((u) => reasons.has(u.userId)).map((u) => ({ ...u, reasons: reasons.get(u.userId)! }))
  const deletable = present.filter((u) => !reasons.has(u.userId))
  const delIds = deletable.map((u) => u.userId)

  const { rows: c } = await pool.query<{ teams: number; memberships: number; tokens: number }>(
    `SELECT (SELECT count(*)::int FROM "Team" WHERE "ownerId" = ANY($1)) AS teams,
            (SELECT count(*)::int FROM "Membership" WHERE "userId" = ANY($1)) AS memberships,
            (SELECT count(*)::int FROM "VerificationToken" WHERE identifier = ANY($2)) AS tokens`,
    [delIds, deletable.map((u) => `email-verify:${u.email.toLowerCase()}`)],
  )

  return {
    jobId,
    pendingToCancel: job.users.filter((u) => u.state === "pending").length,
    alreadyGone,
    mismatched,
    blocked,
    deletable,
    teams: c[0].teams,
    memberships: c[0].memberships,
    tokens: c[0].tokens,
  }
}

/**
 * Cancels whatever the job still has pending, then deletes its deletable users
 * (and their verification tokens) in one transaction. `expected` is the count
 * the operator reviewed; if the DB changed since, nothing is deleted.
 */
export async function runCleanup(pool: Pool, jobId: string, expected: number, confirm: string) {
  if (confirm.trim().toLowerCase() !== TARGET_HOST) throw new Error(`Type ${TARGET_HOST} to confirm.`)
  return withLock(async () => {
    const plan = await planCleanup(pool, jobId)
    if (plan.deletable.length !== expected) {
      throw new Error(`The job changed since you reviewed it (${expected} expected, ${plan.deletable.length} now). Review again.`)
    }

    let deleted: string[] = []
    if (plan.deletable.length) {
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        const res = await client.query<{ id: string }>(
          `DELETE FROM "User" u
            USING unnest($1::text[], $2::text[]) AS rec(id, email)
            WHERE u.id = rec.id AND lower(u.email) = lower(rec.email)
            RETURNING u.id`,
          [plan.deletable.map((u) => u.userId), plan.deletable.map((u) => u.email)],
        )
        if (res.rowCount !== expected) throw new Error(`Would have deleted ${res.rowCount} rows, expected ${expected}. Rolled back.`)
        // VerificationToken has no FK to User, so it doesn't cascade.
        await client.query(`DELETE FROM "VerificationToken" WHERE identifier = ANY($1)`, [
          plan.deletable.map((u) => `email-verify:${u.email.toLowerCase()}`),
        ])
        await client.query("COMMIT")
        deleted = res.rows.map((r) => r.id)
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {})
        throw err
      } finally {
        client.release()
      }
    }

    const job = await loadJob(jobId)
    const del = new Set(deleted)
    const gone = new Set(plan.alreadyGone)
    const freed = new Set<string>()
    const now = new Date().toISOString()
    for (const u of job.users) {
      if (u.state === "pending") {
        u.state = "cancelled"
        freed.add(u.email)
      } else if ((u.userId && del.has(u.userId)) || gone.has(u.email)) {
        u.state = "deleted"
        u.deletedAt = now
        u.verifyAt = undefined
        freed.add(u.email)
      }
    }
    if (job.status !== "done") job.status = "cancelled"
    jobLog(job, `Cleanup: deleted ${deleted.length} users from prod; ${plan.blocked.length + plan.mismatched.length} held back.`)
    await saveJob(job)
    // Deleted emails can be used again in a later test.
    const pl = await getPool()
    await savePool(pl.map((e) => (freed.has(e.email) ? { ...e, status: "available", jobId: undefined } : e)))
    return { deleted: deleted.length, plan }
  })
}
