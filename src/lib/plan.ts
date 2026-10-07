import { randomInt } from "node:crypto"
import { generatePassword } from "./password"
import {
  getPool,
  getSettings,
  jobLog,
  listJobs,
  newJobId,
  saveJob,
  savePool,
  withLock,
  type Job,
  type JobUser,
} from "./store"
import { getConn } from "./db"
import { dayKey, MAX_JOB_SIZE, MAX_VERIFY_DELAY_MIN, MAX_WINDOW_DAYS, TARGET_HOST, timeZone } from "./target"

export type PlanInput = {
  count: number
  windowStart: string // ISO
  windowEnd: string // ISO
  verifyPct: number // 0–100
  verifyDelayMin: [number, number] // minutes after signup
  freeAgentLimit: number | null
  label?: string
}

export type PlanPreview = {
  ok: boolean
  problems: string[]
  available: number
  dailyCap: number
  timeZone: string
  days: { day: string; already: number; planned: number; total: number; over: boolean }[]
  // Signups per bucket across the window, for the preview chart.
  buckets: { start: string; count: number }[]
  expectedVerified: number
  sample: string[]
}

const ACTIVE = new Set<Job["status"]>(["scheduled", "running", "paused"])

function validate(input: PlanInput, available: number): string[] {
  const p: string[] = []
  const start = Date.parse(input.windowStart)
  const end = Date.parse(input.windowEnd)
  if (!Number.isInteger(input.count) || input.count < 1) p.push("Number of users must be at least 1.")
  if (input.count > MAX_JOB_SIZE) p.push(`One schedule is capped at ${MAX_JOB_SIZE.toLocaleString()} users.`)
  if (input.count > available) p.push(`Only ${available} unused emails in the pool; import more or lower the number.`)
  if (Number.isNaN(start) || Number.isNaN(end)) p.push("Pick a start and an end time.")
  else {
    if (end < start) p.push("The window ends before it starts.")
    if (end < Date.now()) p.push("The window is already over.")
    if (end - start > MAX_WINDOW_DAYS * 86_400_000) p.push(`A window can be at most ${MAX_WINDOW_DAYS} days.`)
  }
  if (!(input.verifyPct >= 0 && input.verifyPct <= 100)) p.push("Verified % must be 0–100.")
  const [a, b] = input.verifyDelayMin
  if (!(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= a && b <= MAX_VERIFY_DELAY_MIN)) {
    p.push(`Verify delay must be whole minutes, min ≤ max ≤ ${MAX_VERIFY_DELAY_MIN} (the token expires after 24h).`)
  }
  const l = input.freeAgentLimit
  if (l !== null && !(Number.isInteger(l) && l >= 0 && l <= 100)) p.push("Deploy limit must be 0–100 or blank.")
  return p
}

/** `count` random instants in [start, end], sorted. Starts no earlier than now. */
function randomTimes(count: number, startIso: string, endIso: string): number[] {
  const start = Math.max(Date.parse(startIso), Date.now())
  const end = Math.max(Date.parse(endIso), start)
  const span = end - start
  const out: number[] = []
  for (let i = 0; i < count; i++) out.push(start + (span > 0 ? randomInt(span + 1) : 0))
  return out.sort((x, y) => x - y)
}

/** Users already signed up or still planned, per day, across all jobs. */
async function dailyLoad(): Promise<Map<string, number>> {
  const load = new Map<string, number>()
  for (const j of await listJobs()) {
    for (const u of j.users) {
      const at =
        u.signedUpAt ?? (ACTIVE.has(j.status) && u.state === "pending" ? u.plannedAt : undefined)
      if (at) load.set(dayKey(at), (load.get(dayKey(at)) ?? 0) + 1)
    }
  }
  return load
}

function capCheck(times: number[], load: Map<string, number>, cap: number) {
  const planned = new Map<string, number>()
  for (const t of times) planned.set(dayKey(t), (planned.get(dayKey(t)) ?? 0) + 1)
  const days = [...planned.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, n]) => {
      const already = load.get(day) ?? 0
      return { day, already, planned: n, total: already + n, over: already + n > cap }
    })
  return days
}

function buckets(times: number[], startIso: string, endIso: string) {
  const start = Math.max(Date.parse(startIso), Date.now())
  const end = Math.max(Date.parse(endIso), start + 1)
  const hours = (end - start) / 3_600_000
  // ≤ 48 bars: hourly for short windows, coarser for long ones.
  const size = Math.max(1, Math.ceil(hours / 48)) * 3_600_000
  const n = Math.max(1, Math.ceil((end - start) / size))
  const counts = new Array(n).fill(0)
  for (const t of times) counts[Math.min(n - 1, Math.floor((t - start) / size))]++
  return counts.map((count, i) => ({ start: new Date(start + i * size).toISOString(), count }))
}

export async function previewPlan(input: PlanInput): Promise<PlanPreview> {
  const [pool, settings, load] = await Promise.all([getPool(), getSettings(), dailyLoad()])
  const available = pool.filter((e) => e.status === "available").length
  const problems = validate(input, available)
  const times = problems.length ? [] : randomTimes(input.count, input.windowStart, input.windowEnd)
  const days = capCheck(times, load, settings.dailyCap)
  for (const d of days.filter((d) => d.over)) {
    problems.push(
      `${d.day}: ${d.total} signups (${d.already} already + ${d.planned} new) would exceed the daily cap of ${settings.dailyCap}.`,
    )
  }
  return {
    ok: problems.length === 0,
    problems,
    available,
    dailyCap: settings.dailyCap,
    timeZone: timeZone(),
    days,
    buckets: times.length ? buckets(times, input.windowStart, input.windowEnd) : [],
    expectedVerified: Math.round((input.count * input.verifyPct) / 100),
    sample: times.slice(0, 5).map((t) => new Date(t).toISOString()),
  }
}

/** Skewed toward short delays: most real users click the link quickly. */
function verifyDelay([a, b]: [number, number]): number {
  const r = randomInt(1_000_000) / 1_000_000
  return Math.round(a + (b - a) * r * r)
}

export async function createJob(input: PlanInput, confirm: string): Promise<Job> {
  if (confirm.trim().toLowerCase() !== TARGET_HOST) throw new Error(`Type ${TARGET_HOST} to confirm.`)
  const { database } = getConn()
  return withLock(async () => {
    const [pool, settings, load] = await Promise.all([getPool(), getSettings(), dailyLoad()])
    const avail = pool.filter((e) => e.status === "available")
    const problems = validate(input, avail.length)
    if (problems.length) throw new Error(problems.join(" "))

    const times = randomTimes(input.count, input.windowStart, input.windowEnd)
    const over = capCheck(times, load, settings.dailyCap).filter((d) => d.over)
    if (over.length) {
      throw new Error(
        `Daily cap of ${settings.dailyCap} would be exceeded on ${over.map((d) => `${d.day} (${d.total})`).join(", ")}. Lower the number or widen the window.`,
      )
    }

    const picked = avail.slice(0, input.count)
    // Emails in pool order, times shuffled across them.
    const shuffled = [...times]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const k = randomInt(i + 1)
      ;[shuffled[i], shuffled[k]] = [shuffled[k], shuffled[i]]
    }
    const verifyCount = Math.round((input.count * input.verifyPct) / 100)
    const verifySet = new Set<number>()
    while (verifySet.size < verifyCount) verifySet.add(randomInt(input.count))

    const id = newJobId()
    const users: JobUser[] = picked.map((e, i) => ({
      email: e.email,
      name: e.name,
      location: e.location,
      password: generatePassword(),
      plannedAt: new Date(shuffled[i]).toISOString(),
      willVerify: verifySet.has(i),
      verifyDelayMin: verifyDelay(input.verifyDelayMin),
      state: "pending",
      deferrals: 0,
    }))
    users.sort((a, b) => a.plannedAt.localeCompare(b.plannedAt))

    const job: Job = {
      id,
      createdAt: new Date().toISOString(),
      label: input.label?.trim() || `${input.count} users`,
      status: "scheduled",
      windowStart: new Date(Math.max(Date.parse(input.windowStart), Date.now())).toISOString(),
      windowEnd: input.windowEnd,
      verifyPct: input.verifyPct,
      verifyDelayMin: input.verifyDelayMin,
      freeAgentLimit: input.freeAgentLimit,
      database,
      users,
      log: [],
    }
    jobLog(job, `Scheduled ${users.length} signups (${verifyCount} will verify) between ${job.windowStart} and ${job.windowEnd}.`)
    await saveJob(job)

    const pickedSet = new Set(picked.map((p) => p.email))
    await savePool(pool.map((e) => (pickedSet.has(e.email) ? { ...e, status: "scheduled", jobId: id } : e)))
    return job
  })
}
