import { verifiedPool } from "./db"
import type { InputRow } from "./emails"
import { getPool, savePool, withLock, type PoolEntry } from "./store"
import { MAX_POOL_SIZE } from "./target"

export type ImportResult = {
  added: number
  alreadyInPool: number
  existsOnProd: number
  poolSize: number
}

/**
 * Adds parsed rows to the pool. Emails already in the pool (in any state) are
 * ignored; emails already registered on prod are recorded as `exists` and will
 * never be scheduled.
 */
export async function importRows(rows: InputRow[]): Promise<ImportResult> {
  const pool = await verifiedPool()
  return withLock(async () => {
    const entries = await getPool()
    const known = new Set(entries.map((e) => e.email))
    const fresh = rows.filter((r) => !known.has(r.email))
    if (entries.length + fresh.length > MAX_POOL_SIZE) {
      throw new Error(`The pool would exceed ${MAX_POOL_SIZE.toLocaleString()} emails. Clear used ones first.`)
    }

    const onProd = new Set<string>()
    for (let i = 0; i < fresh.length; i += 1000) {
      const chunk = fresh.slice(i, i + 1000).map((r) => r.email)
      const { rows: found } = await pool.query<{ e: string }>(
        `SELECT lower(email) AS e FROM "User" WHERE lower(email) = ANY($1)`,
        [chunk],
      )
      found.forEach((f) => onProd.add(f.e))
    }

    const now = new Date().toISOString()
    const added: PoolEntry[] = fresh.map((r) => ({
      email: r.email,
      name: r.name,
      location: r.location,
      addedAt: now,
      status: onProd.has(r.email) ? "exists" : "available",
    }))
    await savePool([...entries, ...added])
    return {
      added: added.filter((a) => a.status === "available").length,
      alreadyInPool: rows.length - fresh.length,
      existsOnProd: onProd.size,
      poolSize: entries.length + added.length,
    }
  })
}

export async function poolSummary() {
  const entries = await getPool()
  const count = (s: PoolEntry["status"]) => entries.filter((e) => e.status === s).length
  return {
    total: entries.length,
    available: count("available"),
    scheduled: count("scheduled"),
    done: count("done"),
    exists: count("exists"),
    sample: entries.filter((e) => e.status === "available").slice(0, 25),
  }
}

/** Removes entries that are not tied to a live job (available + exists). */
export async function clearPool(which: "available" | "exists" | "unused") {
  return withLock(async () => {
    const entries = await getPool()
    const keep = entries.filter((e) =>
      which === "unused" ? e.status === "scheduled" || e.status === "done" : e.status !== which,
    )
    await savePool(keep)
    return { removed: entries.length - keep.length }
  })
}
