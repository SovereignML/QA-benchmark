import { verifiedPool } from "./db"
import { signUp, verifyEmail } from "./executor"
import { dayKey, VERIFY_TOKEN_TTL_MS } from "./target"
import { getPool, getSettings, jobLog, listJobs, loadJob, saveJob, savePool, withLock, type Job } from "./store"

// In-process scheduler. Started once from src/instrumentation.ts.
//
// Every TICK_MS it walks active jobs and performs due events: signups whose
// plannedAt has passed, then verifications whose verifyAt has passed. At most
// MAX_PER_TICK events per tick, so after downtime the backlog drains at a
// steady pace instead of in one burst.
const TICK_MS = 10_000
const MAX_PER_TICK = 20

type State = {
  started: boolean
  timer?: ReturnType<typeof setInterval>
  running: boolean
  lastTickAt?: string
  lastError?: string
  lastErrorAt?: string
}
const g = globalThis as unknown as { __autosignupScheduler?: State }
const state: State = (g.__autosignupScheduler ??= { started: false, running: false })

export function schedulerStatus() {
  return { started: state.started, lastTickAt: state.lastTickAt, lastError: state.lastError, lastErrorAt: state.lastErrorAt, tickMs: TICK_MS }
}

export function startScheduler() {
  if (state.started || process.env.AUTOSIGNUP_SCHEDULER === "off") return
  state.started = true
  state.timer = setInterval(() => void tick(), TICK_MS)
  void tick()
}

function isDone(j: Job) {
  return j.users.every(
    (u) => u.state !== "pending" && !(u.state === "signed-up" && u.willVerify && u.verifyAt),
  )
}

export async function tick() {
  if (state.running) return
  state.running = true
  try {
    const pool = await verifiedPool()
    const settings = await getSettings()
    const today = dayKey(Date.now())
    const all = await listJobs()
    let createdToday = 0
    for (const j of all) for (const u of j.users) if (u.signedUpAt && dayKey(u.signedUpAt) === today) createdToday++

    let budget = MAX_PER_TICK
    for (const summary of all.filter((j) => j.status === "scheduled" || j.status === "running")) {
      if (budget <= 0) break
      await withLock(async () => {
        const job = await loadJob(summary.id) // fresh copy under the lock
        if (job.status !== "scheduled" && job.status !== "running") return
        const now = Date.now()
        const finishedEmails: string[] = []
        let changed = false

        for (const u of job.users) {
          if (budget <= 0) break

          if (u.state === "pending" && Date.parse(u.plannedAt) <= now) {
            if (createdToday >= settings.dailyCap) {
              // Over today's cap: push this signup to the same time tomorrow.
              u.plannedAt = new Date(Date.parse(u.plannedAt) + 86_400_000).toISOString()
              u.deferrals++
              jobLog(job, `${u.email}: daily cap ${settings.dailyCap} reached, moved to ${u.plannedAt}.`)
              changed = true
              continue
            }
            budget--
            changed = true
            if (job.status === "scheduled") job.status = "running"
            try {
              const r = await signUp(pool, u, job.freeAgentLimit)
              if (r.kind === "exists") {
                u.state = "skipped"
                u.error = "Email already registered on prod"
              } else {
                createdToday++
                u.state = "signed-up"
                u.userId = r.userId
                u.teamId = r.teamId
                u.signedUpAt = r.signedUpAt
                if (u.willVerify) {
                  u.verifyAt = new Date(Date.parse(r.signedUpAt) + u.verifyDelayMin * 60_000).toISOString()
                }
              }
              finishedEmails.push(u.email)
            } catch (err) {
              u.state = "failed"
              u.error = (err as Error).message
              jobLog(job, `${u.email}: signup failed — ${u.error}`)
            }
            continue
          }

          if (u.state === "signed-up" && u.willVerify && u.verifyAt && Date.parse(u.verifyAt) <= now) {
            budget--
            changed = true
            // A real user can't verify with an expired token. If we were down
            // past the 24h TTL, this user simply never verifies.
            if (u.signedUpAt && now - Date.parse(u.signedUpAt) > VERIFY_TOKEN_TTL_MS) {
              u.verifyAt = undefined
              u.willVerify = false
              jobLog(job, `${u.email}: verification window (24h) passed while paused/down; left unverified.`)
              continue
            }
            try {
              const r = await verifyEmail(pool, u)
              if (r.kind === "verified") {
                u.state = "verified"
                u.verifiedAt = r.verifiedAt
              } else if (r.kind === "already") {
                u.state = "verified"
              } else {
                u.state = "failed"
                u.error = "User no longer exists on prod"
              }
            } catch (err) {
              u.error = `verify: ${(err as Error).message}`
              jobLog(job, `${u.email}: verify failed — ${(err as Error).message}`)
              u.verifyAt = new Date(now + 60_000).toISOString() // retry in a minute
            }
          }
        }

        if (job.status === "running" && isDone(job)) {
          job.status = "done"
          jobLog(job, "All events completed.")
          changed = true
        }
        if (changed) await saveJob(job)
        if (finishedEmails.length) {
          const set = new Set(finishedEmails)
          const pl = await getPool()
          await savePool(pl.map((e) => (set.has(e.email) ? { ...e, status: "done" } : e)))
        }
      })
    }
    state.lastError = undefined
  } catch (err) {
    state.lastError = (err as Error).message
    state.lastErrorAt = new Date().toISOString()
  } finally {
    state.lastTickAt = new Date().toISOString()
    state.running = false
  }
}

// ---- Job controls ------------------------------------------------------------------

export async function controlJob(id: string, action: "pause" | "resume" | "cancel") {
  return withLock(async () => {
    const job = await loadJob(id)
    if (action === "pause") {
      if (job.status !== "scheduled" && job.status !== "running") throw new Error(`Can't pause a ${job.status} job.`)
      job.status = "paused"
      jobLog(job, "Paused.")
    } else if (action === "resume") {
      if (job.status !== "paused") throw new Error("Only a paused job can be resumed.")
      // Spread anything that fell due while paused over the next hour rather
      // than firing it all at once.
      const now = Date.now()
      let moved = 0
      for (const u of job.users) {
        if (u.state === "pending" && Date.parse(u.plannedAt) < now) {
          u.plannedAt = new Date(now + Math.floor(Math.random() * 3_600_000)).toISOString()
          moved++
        }
      }
      job.users.sort((a, b) => a.plannedAt.localeCompare(b.plannedAt))
      job.status = job.users.some((u) => u.signedUpAt) ? "running" : "scheduled"
      jobLog(job, `Resumed${moved ? `; ${moved} overdue signups spread over the next hour` : ""}.`)
    } else {
      if (job.status === "done" || job.status === "cancelled") throw new Error(`Job is already ${job.status}.`)
      const released = new Set<string>()
      for (const u of job.users) {
        if (u.state === "pending") {
          u.state = "cancelled"
          released.add(u.email)
        }
        // Signed up but not yet verified: stays unverified, like a user who
        // never clicked the link.
        if (u.state === "signed-up") u.verifyAt = undefined
      }
      job.status = "cancelled"
      jobLog(job, `Cancelled; ${released.size} unsent emails returned to the pool.`)
      const pl = await getPool()
      await savePool(pl.map((e) => (released.has(e.email) ? { ...e, status: "available", jobId: undefined } : e)))
    }
    await saveJob(job)
    return job
  })
}
