import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { DEFAULT_DAILY_CAP } from "./target"

// Local state, as JSON files under AUTOSIGNUP_DATA_DIR (default ./data):
//   settings.json      daily cap
//   pool.json          imported emails not yet used / their fate
//   jobs/<id>.json     each schedule and every user it plans or created
//
// The job files ARE the record of every test user: email, plain-text password,
// planned and actual signup time, verification, prod ids. Cleanup trusts them.
// The folder is mode 700 and gitignored; never commit or share it.

export function dataDir() {
  return process.env.AUTOSIGNUP_DATA_DIR || path.join(process.cwd(), "data")
}
const jobsDir = () => path.join(dataDir(), "jobs")

// ---- One writer at a time ---------------------------------------------------
// The scheduler and API routes both read-modify-write these files. A single
// in-process mutex serializes that (run AutoSignUp as ONE process — pm2 fork
// mode, not cluster).
const g = globalThis as unknown as { __autosignupLock?: Promise<unknown> }
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = g.__autosignupLock ?? Promise.resolve()
  const next = prev.then(fn, fn)
  g.__autosignupLock = next.catch(() => {})
  return next
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 1), { mode: 0o600 })
  await rename(tmp, file)
}
async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return fallback
    throw err
  }
}

// ---- Settings ---------------------------------------------------------------

export type Settings = { dailyCap: number }
export const getSettings = () =>
  readJson<Settings>(path.join(dataDir(), "settings.json"), { dailyCap: DEFAULT_DAILY_CAP })
export const saveSettings = (s: Settings) => writeJson(path.join(dataDir(), "settings.json"), s)

// ---- Email pool ---------------------------------------------------------------

export type PoolEntry = {
  email: string
  name: string
  location: string
  addedAt: string
  // available → scheduled (in a job) → done (created on prod), or
  // exists (already registered on prod — never touched).
  status: "available" | "scheduled" | "done" | "exists"
  jobId?: string
}
const poolFile = () => path.join(dataDir(), "pool.json")
export const getPool = () => readJson<PoolEntry[]>(poolFile(), [])
export const savePool = (p: PoolEntry[]) => writeJson(poolFile(), p)

// ---- Jobs -------------------------------------------------------------------------

export type JobUserState =
  | "pending" // planned, not yet signed up
  | "signed-up" // User/Team/Membership/token exist; email not verified
  | "verified" // emailVerified set
  | "skipped" // email already registered by the time we got to it
  | "failed"
  | "cancelled" // job cancelled before this user's turn
  | "deleted" // removed by cleanup

export type JobUser = {
  email: string
  name: string
  location: string
  password: string
  plannedAt: string // when the signup is scheduled
  willVerify: boolean
  verifyDelayMin: number // minutes after the actual signup
  state: JobUserState
  deferrals: number // times pushed a day later by the daily cap
  userId?: string
  teamId?: string
  signedUpAt?: string // User.createdAt as written by Postgres
  verifyAt?: string // planned verification time, set at signup
  verifiedAt?: string // User.emailVerified as written by Postgres
  error?: string
  deletedAt?: string
}

export type Job = {
  id: string
  createdAt: string
  label: string
  status: "scheduled" | "running" | "paused" | "done" | "cancelled"
  windowStart: string
  windowEnd: string
  verifyPct: number
  verifyDelayMin: [number, number]
  freeAgentLimit: number | null
  database: string
  users: JobUser[]
  log: { at: string; msg: string }[]
}

export function newJobId(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `j${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`
}

function jobFile(id: string) {
  if (!/^j[0-9-]+-[a-z0-9]+$/.test(id)) throw new Error("Bad job id")
  return path.join(jobsDir(), `${id}.json`)
}

export async function loadJob(id: string): Promise<Job> {
  const j = await readJson<Job | null>(jobFile(id), null)
  if (!j) throw new Error("Job not found.")
  return j
}
export const saveJob = (j: Job) => writeJson(jobFile(j.id), j)

export async function listJobs(): Promise<Job[]> {
  let names: string[] = []
  try {
    names = await readdir(jobsDir())
  } catch {
    return []
  }
  const out: Job[] = []
  for (const n of names.filter((n) => n.endsWith(".json"))) {
    try {
      out.push(JSON.parse(await readFile(path.join(jobsDir(), n), "utf8")))
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function jobLog(j: Job, msg: string) {
  j.log.push({ at: new Date().toISOString(), msg })
  if (j.log.length > 500) j.log.splice(0, j.log.length - 500)
}
