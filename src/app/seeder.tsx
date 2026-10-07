"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"

const TARGET = "app.atlasagents.dev"

// ---- API types (mirror src/lib) --------------------------------------------------

type SchemaReport = { ok: boolean; problems: string[]; database: string; userCount: number; serverVersion: string }
type PoolSummary = {
  total: number
  available: number
  scheduled: number
  done: number
  exists: number
  sample: { email: string; name: string; location: string }[]
}
type Status = {
  target: string
  timeZone: string
  today: string
  now: string
  db: { ok: true; display: string; report: SchemaReport } | { ok: false; error: string }
  scheduler: { started: boolean; lastTickAt?: string; lastError?: string; lastErrorAt?: string; tickMs: number }
  settings: { dailyCap: number }
  createdToday: number
  plannedToday: number
  nextEvent: string | null
  pool: PoolSummary
  totals: { jobs: number; created: number; verified: number }
}
type ParseCounts = { total: number; valid: number; invalid: number; duplicate: number }
type ParsedRow = { line: number; email: string; name: string; status: string; reason?: string }
type Preview = {
  ok: boolean
  problems: string[]
  available: number
  dailyCap: number
  timeZone: string
  days: { day: string; already: number; planned: number; total: number; over: boolean }[]
  buckets: { start: string; count: number }[]
  expectedVerified: number
}
type JobSummary = {
  id: string
  label: string
  createdAt: string
  status: "scheduled" | "running" | "paused" | "done" | "cancelled"
  windowStart: string
  windowEnd: string
  verifyPct: number
  verifyDelayMin: [number, number]
  freeAgentLimit: number | null
  database: string
  total: number
  pending: number
  signedUp: number
  verified: number
  skipped: number
  failed: number
  cancelled: number
  deleted: number
  awaitingVerify: number
  deferrals: number
  nextEvent: string | null
  lastLog: { at: string; msg: string }[]
}
type JobUser = {
  email: string
  name: string
  password: string
  plannedAt: string
  willVerify: boolean
  verifyDelayMin: number
  state: string
  signedUpAt?: string
  verifyAt?: string
  verifiedAt?: string
  error?: string
}
type JobDetail = JobSummary & { users: JobUser[]; log: { at: string; msg: string }[] }
type CleanupPlan = {
  pendingToCancel: number
  alreadyGone: string[]
  mismatched: { userId: string; recordedEmail: string; currentEmail: string }[]
  blocked: { userId: string; email: string; reasons: string[] }[]
  deletable: { userId: string; email: string }[]
  teams: number
  memberships: number
  tokens: number
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`)
  return data as T
}
const send = <T,>(url: string, method: string, body: unknown) =>
  api<T>(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

// ---- Formatting -----------------------------------------------------------------------

const fmtTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"
const fmtFull = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"
function relative(iso?: string | null) {
  if (!iso) return "—"
  const s = Math.round((Date.parse(iso) - Date.now()) / 1000)
  const a = Math.abs(s)
  const v = a < 60 ? `${a}s` : a < 3600 ? `${Math.round(a / 60)}m` : a < 86400 ? `${(a / 3600).toFixed(1)}h` : `${(a / 86400).toFixed(1)}d`
  return s >= 0 ? `in ${v}` : `${v} ago`
}
// ---- Primitives -------------------------------------------------------------------------

const btnBase =
  "inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-sm font-medium whitespace-nowrap transition disabled:cursor-not-allowed disabled:opacity-40"
const btnVariants = {
  primary: "bg-accent text-accent-fg hover:opacity-90",
  ghost: "border border-line bg-panel hover:bg-code",
  danger: "bg-bad text-white hover:opacity-90",
}
function Button({
  children,
  variant = "primary",
  ...p
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof btnVariants }) {
  return (
    <button {...p} className={`${btnBase} ${btnVariants[variant]} ${p.className ?? ""}`}>
      {children}
    </button>
  )
}
const inputCls =
  "h-9 w-full rounded-lg border border-line bg-bg px-3 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"

function Section({ title, hint, right, children }: { title: string; hint?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-panel p-5 sm:p-6">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {hint && <p className="mt-0.5 text-sm text-muted">{hint}</p>}
        </div>
        {right}
      </header>
      {children}
    </section>
  )
}
function Note({ tone, children }: { tone: "ok" | "warn" | "bad" | "info"; children: ReactNode }) {
  const t = { ok: "bg-ok-bg text-ok", warn: "bg-warn-bg text-warn", bad: "bg-bad-bg text-bad", info: "bg-code text-muted" }[tone]
  return <div className={`rounded-lg px-3 py-2 text-sm ${t}`}>{children}</div>
}
function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "ok" | "warn" | "bad" }) {
  const c = tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : tone === "bad" ? "text-bad" : ""
  return (
    <div className="min-w-0 rounded-lg border border-line px-3 py-2">
      <div className="truncate text-xs text-muted">{label}</div>
      <div className={`truncate text-lg font-semibold tabular-nums ${c}`}>{value}</div>
      {sub && <div className="truncate text-xs text-muted">{sub}</div>}
    </div>
  )
}
function Field({ label, htmlFor, help, children }: { label: string; htmlFor: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {help && <span className="text-xs text-muted">{help}</span>}
    </div>
  )
}
function Mono({ children }: { children: ReactNode }) {
  return <code className="rounded bg-code px-1.5 py-0.5 font-mono text-[0.8125rem]">{children}</code>
}
function Chip({ status }: { status: string }) {
  const tone =
    status === "running" || status === "verified"
      ? "bg-ok-bg text-ok"
      : status === "failed"
        ? "bg-bad-bg text-bad"
        : status === "paused" || status === "signed-up" || status === "skipped"
          ? "bg-warn-bg text-warn"
          : status === "scheduled" || status === "pending"
            ? "bg-accent/15 text-accent"
            : "bg-code text-muted"
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${tone}`}>{status}</span>
}

// ---- Page ------------------------------------------------------------------------------

export function Seeder() {
  const [status, setStatus] = useState<Status | null>(null)
  const [statusErr, setStatusErr] = useState("")
  const [jobs, setJobs] = useState<JobSummary[]>([])

  const refresh = useCallback(async () => {
    try {
      const [s, j] = await Promise.all([api<Status>("/api/status"), api<JobSummary[]>("/api/jobs")])
      setStatus(s)
      setJobs(j)
      setStatusErr("")
    } catch (e) {
      setStatusErr((e as Error).message)
    }
  }, [])

  useEffect(() => {
    // Initial load + poll; the scheduler works in the background.
    const first = setTimeout(refresh, 0)
    const t = setInterval(refresh, 5000)
    return () => {
      clearTimeout(first)
      clearInterval(t)
    }
  }, [refresh])

  const dbOk = status?.db.ok && status.db.report.ok

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:py-10">
      <header className="mb-6">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">AutoSignUp</h1>
          <span className="rounded-full bg-bad-bg px-2.5 py-0.5 text-xs font-medium text-bad">Production · {TARGET}</span>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-muted">
          Schedules test signups straight into the production database, exactly as the signup form would leave them —
          minus the email, analytics and ad events. Every account is recorded here with its password and timestamps.
        </p>
      </header>

      {statusErr && (
        <div className="mb-4">
          <Note tone="bad">AutoSignUp server unreachable: {statusErr}</Note>
        </div>
      )}

      <div className="flex flex-col gap-5">
        <StatusStrip status={status} onChanged={refresh} />
        <PoolSection status={status} dbOk={!!dbOk} onChanged={refresh} />
        <ScheduleSection status={status} dbOk={!!dbOk} onCreated={refresh} />
        <JobsSection jobs={jobs} dbOk={!!dbOk} onChanged={refresh} />
        <RecordsSection status={status} />
      </div>
    </main>
  )
}

// ---- Status ------------------------------------------------------------------------------

function StatusStrip({ status, onChanged }: { status: Status | null; onChanged: () => Promise<void> }) {
  const [editCap, setEditCap] = useState(false)
  const [cap, setCap] = useState("")
  const [capErr, setCapErr] = useState("")

  if (!status) return <Section title="Status"><span className="text-sm text-muted">Loading…</span></Section>
  const db = status.db
  const sched = status.scheduler
  const tickStale = !sched.lastTickAt || Date.parse(status.now) - Date.parse(sched.lastTickAt) > sched.tickMs * 4
  const capUsed = status.createdToday / status.settings.dailyCap

  async function saveCap() {
    setCapErr("")
    try {
      await send("/api/settings", "PUT", { dailyCap: Number(cap) })
      setEditCap(false)
      await onChanged()
    } catch (e) {
      setCapErr((e as Error).message)
    }
  }

  return (
    <Section
      title="Status"
      hint={`Daily cap counts calendar days in ${status.timeZone}. Today is ${status.today}.`}
      right={
        db.ok ? (
          <span className="font-mono text-xs break-all text-muted">{db.display}</span>
        ) : null
      }
    >
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <Stat
          label="Production DB"
          value={db.ok ? (db.report.ok ? "Connected" : "Schema problem") : "Down"}
          tone={db.ok && db.report.ok ? "ok" : "bad"}
          sub={db.ok ? `${db.report.userCount.toLocaleString()} users · ${db.report.database}` : undefined}
        />
        <Stat
          label="Scheduler"
          value={sched.lastError ? "Error" : tickStale ? "Idle" : "Running"}
          tone={sched.lastError ? "bad" : tickStale ? "warn" : "ok"}
          sub={`last tick ${relative(sched.lastTickAt)}`}
        />
        <Stat
          label={`Signed up today / cap`}
          value={`${status.createdToday} / ${status.settings.dailyCap}`}
          tone={capUsed >= 1 ? "bad" : capUsed > 0.8 ? "warn" : undefined}
          sub={`${status.plannedToday} more planned today`}
        />
        <Stat label="Next event" value={relative(status.nextEvent)} sub={fmtTime(status.nextEvent)} />
        <Stat label="Test users live" value={status.totals.created} sub={`${status.totals.verified} verified`} />
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-code" title="Today's signups against the daily cap">
        <div
          className={`h-full ${capUsed >= 1 ? "bg-bad" : capUsed > 0.8 ? "bg-warn" : "bg-accent"}`}
          style={{ width: `${Math.min(100, capUsed * 100)}%` }}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        {editCap ? (
          <>
            <label htmlFor="cap" className="text-muted">Daily cap</label>
            <input id="cap" inputMode="numeric" className={`${inputCls} w-24`} value={cap} onChange={(e) => setCap(e.target.value)} />
            <Button onClick={saveCap}>Save</Button>
            <Button variant="ghost" onClick={() => setEditCap(false)}>Cancel</Button>
            {capErr && <span className="text-bad">{capErr}</span>}
          </>
        ) : (
          <button
            className="text-accent"
            onClick={() => {
              setCap(String(status.settings.dailyCap))
              setEditCap(true)
            }}
          >
            Change daily cap ({status.settings.dailyCap}/day)
          </button>
        )}
      </div>

      {!db.ok && <div className="mt-3"><Note tone="bad">{db.error}</Note></div>}
      {db.ok && !db.report.ok && (
        <div className="mt-3">
          <Note tone="bad">
            <strong>Writes are blocked</strong> until the schema matches:
            <ul className="mt-1 list-disc pl-5">{db.report.problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </Note>
        </div>
      )}
      {sched.lastError && <div className="mt-3"><Note tone="bad">Scheduler: {sched.lastError} ({relative(sched.lastErrorAt)})</Note></div>}
    </Section>
  )
}

// ---- Email pool -------------------------------------------------------------------------------

function PoolSection({ status, dbOk, onChanged }: { status: Status | null; dbOk: boolean; onChanged: () => Promise<void> }) {
  const [mode, setMode] = useState<"upload" | "paste">("upload")
  const [text, setText] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [check, setCheck] = useState<{ counts: ParseCounts; rows: ParsedRow[] } | null>(null)
  const [msg, setMsg] = useState<{ tone: "ok" | "bad" | "warn"; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const pool = status?.pool

  function body(): RequestInit {
    if (mode === "upload" && file) {
      const fd = new FormData()
      fd.append("file", file)
      return { method: "POST", body: fd }
    }
    return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }
  }

  async function runCheck() {
    setMsg(null)
    try {
      const r = await api<{ parsed: { counts: ParseCounts; rows: ParsedRow[] } }>("/api/pool?check=1", body())
      setCheck(r.parsed)
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message })
    }
  }

  async function runImport() {
    setBusy(true)
    setMsg(null)
    try {
      const r = await api<{ result: { added: number; alreadyInPool: number; existsOnProd: number } }>("/api/pool", body())
      setMsg({
        tone: "ok",
        text: `Added ${r.result.added} emails. ${r.result.alreadyInPool} were already in the pool; ${r.result.existsOnProd} already have a prod account and will never be used.`,
      })
      setCheck(null)
      setText("")
      setFile(null)
      if (fileRef.current) fileRef.current.value = ""
      await onChanged()
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  async function clear(which: "available" | "exists") {
    const r = await api<{ removed: number }>(`/api/pool?which=${which}`, { method: "DELETE" })
    setMsg({ tone: "ok", text: `Removed ${r.removed} emails from the pool.` })
    await onChanged()
  }

  const ready = mode === "upload" ? !!file : !!text.trim()
  const problems = check?.rows.filter((r) => r.status !== "valid") ?? []

  return (
    <Section
      title="1 · Email pool"
      hint="Import once — any size. Schedules draw from the unused emails here."
      right={
        <a className={`${btnBase} ${btnVariants.ghost}`} href="/api/pool/template">
          Excel template
        </a>
      }
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Unused" value={pool?.available ?? "—"} tone="ok" />
        <Stat label="Scheduled" value={pool?.scheduled ?? "—"} />
        <Stat label="Signed up" value={pool?.done ?? "—"} />
        <Stat label="Already on prod" value={pool?.exists ?? "—"} tone={pool?.exists ? "warn" : undefined} sub="never used" />
      </div>

      <div className="mt-4 inline-flex rounded-lg border border-line p-0.5 text-sm">
        {(["upload", "paste"] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m)
              setCheck(null)
            }}
            className={`rounded-md px-3 py-1 ${mode === m ? "bg-code font-medium" : "text-muted"}`}
          >
            {m === "paste" ? "Paste" : "Excel / CSV"}
          </button>
        ))}
      </div>

      <div className="mt-3 flex flex-col gap-3">
        {mode === "upload" ? (
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.csv,.txt"
            className="text-sm file:mr-3 file:h-9 file:rounded-lg file:border file:border-line file:bg-panel file:px-3 file:text-sm file:text-fg"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null)
              setCheck(null)
            }}
          />
        ) : (
          <textarea
            className="min-h-28 w-full rounded-lg border border-line bg-bg p-3 font-mono text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            placeholder={"qa1@yourdomain.com\nqa2@yourdomain.com, Jane Tester, Dhaka"}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setCheck(null)
            }}
          />
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={runCheck} disabled={!ready}>
            Check
          </Button>
          <Button onClick={runImport} disabled={!ready || busy || !dbOk}>
            {busy ? "Importing…" : "Add to pool"}
          </Button>
        </div>

        {check && (
          <div className="flex flex-col gap-2">
            <div className="text-sm">
              <span className="text-ok">{check.counts.valid} valid</span> ·{" "}
              <span className={check.counts.invalid ? "text-bad" : "text-muted"}>{check.counts.invalid} invalid</span> ·{" "}
              <span className={check.counts.duplicate ? "text-warn" : "text-muted"}>{check.counts.duplicate} duplicate</span>{" "}
              <span className="text-muted">of {check.counts.total} rows</span>
            </div>
            {problems.length > 0 && (
              <ul className="max-h-32 overflow-auto rounded-lg bg-code p-2 font-mono text-xs">
                {problems.slice(0, 100).map((r) => (
                  <li key={`${r.line}-${r.email}`}>
                    row {r.line}: {r.email || "(blank)"} — {r.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {msg && <Note tone={msg.tone}>{msg.text}</Note>}

        {pool && pool.available + pool.exists > 0 && (
          <div className="flex flex-wrap gap-3 text-sm">
            {pool.available > 0 && (
              <button className="text-muted hover:text-bad" onClick={() => clear("available")}>
                Remove {pool.available} unused
              </button>
            )}
            {pool.exists > 0 && (
              <button className="text-muted hover:text-bad" onClick={() => clear("exists")}>
                Remove {pool.exists} already-on-prod
              </button>
            )}
          </div>
        )}
      </div>
    </Section>
  )
}

// ---- New schedule ------------------------------------------------------------------------------

function ScheduleSection({ status, dbOk, onCreated }: { status: Status | null; dbOk: boolean; onCreated: () => Promise<void> }) {
  const [label, setLabel] = useState("")
  const [count, setCount] = useState("200")
  // Empty = "now", resolved when you press Preview / Schedule.
  const [start, setStart] = useState("")
  const [hours, setHours] = useState("10")
  const [verifyPct, setVerifyPct] = useState("65")
  const [delayMin, setDelayMin] = useState("2")
  const [delayMax, setDelayMax] = useState("240")
  const [limit, setLimit] = useState("0")
  const [preview, setPreview] = useState<Preview | null>(null)
  const [err, setErr] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState("")

  const startDate = start ? new Date(start) : null
  const endDate = startDate ? new Date(startDate.getTime() + Number(hours) * 3_600_000) : null

  function plan() {
    const s = startDate ?? new Date()
    return {
      label,
      count: Number(count),
      windowStart: s.toISOString(),
      windowEnd: new Date(s.getTime() + Number(hours) * 3_600_000).toISOString(),
      verifyPct: Number(verifyPct),
      verifyDelayMin: [Number(delayMin), Number(delayMax)] as [number, number],
      freeAgentLimit: limit.trim() === "" ? null : Number(limit),
    }
  }
  const valid = (!startDate || !Number.isNaN(startDate.getTime())) && Number(hours) > 0 && Number(count) > 0

  async function runPreview() {
    setErr("")
    setDone("")
    try {
      setPreview(await send<Preview>("/api/jobs/preview", "POST", { plan: plan() }))
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  async function create() {
    setBusy(true)
    setErr("")
    try {
      const j = await send<JobSummary>("/api/jobs", "POST", { plan: plan(), confirm })
      setDone(`Scheduled “${j.label}”: ${j.total} signups between ${fmtTime(j.windowStart)} and ${fmtTime(j.windowEnd)}.`)
      setPreview(null)
      setConfirm("")
      await onCreated()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Any edit invalidates the preview.
  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    set(v)
    setPreview(null)
  }

  const maxBucket = Math.max(1, ...(preview?.buckets.map((b) => b.count) ?? [1]))
  const limitNum = limit.trim() === "" ? null : Number(limit)

  return (
    <Section title="2 · Schedule signups" hint="Each user signs up at a random moment in the window; a share of them verify their email a random delay later.">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Users" htmlFor="count" help={status ? `${status.pool.available} unused in pool` : undefined}>
          <input id="count" inputMode="numeric" className={inputCls} value={count} onChange={(e) => edit(setCount)(e.target.value)} />
        </Field>
        <Field
          label="Start"
          htmlFor="start"
          help={
            start ? (
              <button className="text-accent" onClick={() => edit(setStart)("")}>Start now instead</button>
            ) : (
              "Blank = now"
            )
          }
        >
          <input id="start" type="datetime-local" className={inputCls} value={start} onChange={(e) => edit(setStart)(e.target.value)} />
        </Field>
        <Field label="Over (hours)" htmlFor="hours" help={endDate && valid ? `ends ${fmtTime(endDate.toISOString())}` : `${hours || 0}h from start`}>
          <input id="hours" inputMode="decimal" className={inputCls} value={hours} onChange={(e) => edit(setHours)(e.target.value)} />
        </Field>
        <Field label="Label (optional)" htmlFor="label">
          <input id="label" className={inputCls} value={label} placeholder={`${count || 0} users`} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label={`Verify email: ${verifyPct}%`} htmlFor="vp" help="The rest stay unverified, like users who never click the link.">
          <input id="vp" type="range" min={0} max={100} step={5} value={verifyPct} onChange={(e) => edit(setVerifyPct)(e.target.value)} className="accent-[var(--accent)]" />
        </Field>
        <Field label="Verify after (minutes)" htmlFor="dmin" help="Random in this range, mostly toward the short end. Max 1380 (token lives 24h).">
          <div className="flex items-center gap-2">
            <input id="dmin" inputMode="numeric" className={inputCls} value={delayMin} onChange={(e) => edit(setDelayMin)(e.target.value)} />
            <span className="text-muted">–</span>
            <input aria-label="Maximum verify delay" inputMode="numeric" className={inputCls} value={delayMax} onChange={(e) => edit(setDelayMax)(e.target.value)} />
          </div>
        </Field>
        <Field
          label="Free agent deploys"
          htmlFor="limit"
          help={
            limitNum === 0 ? "0 — can't start a VM." : limitNum === null ? <span className="text-warn">Platform default — can start real, billed VMs.</span> : <span className="text-warn">Can start {limitNum} billed VM(s).</span>
          }
        >
          <input id="limit" inputMode="numeric" className={inputCls} value={limit} placeholder="blank = default" onChange={(e) => edit(setLimit)(e.target.value)} />
        </Field>
        <div className="flex items-end">
          <Button variant="ghost" onClick={runPreview} disabled={!valid || !dbOk} className="w-full">
            Preview
          </Button>
        </div>
      </div>

      {err && <div className="mt-4"><Note tone="bad">{err}</Note></div>}
      {done && <div className="mt-4"><Note tone="ok">{done}</Note></div>}

      {preview && (
        <div className="mt-5 flex flex-col gap-4 border-t border-line pt-5">
          {preview.buckets.length > 0 && (
            <div>
              <div className="mb-1 text-xs text-muted">Signups across the window (one random draw — the real run re-draws)</div>
              <div className="flex h-24 items-end gap-px rounded-lg bg-code p-2" role="img" aria-label="Signups per time bucket">
                {preview.buckets.map((b) => (
                  <div key={b.start} className="flex-1 rounded-sm bg-accent/80" style={{ height: `${(b.count / maxBucket) * 100}%`, minHeight: b.count ? 2 : 0 }} title={`${fmtTime(b.start)} — ${b.count}`} />
                ))}
              </div>
              <div className="mt-1 flex justify-between text-xs text-muted">
                <span>{fmtTime(preview.buckets[0].start)}</span>
                <span>{fmtTime(preview.buckets[preview.buckets.length - 1].start)}</span>
              </div>
            </div>
          )}

          {preview.days.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-left text-sm">
                <thead className="bg-code text-xs text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Day ({preview.timeZone})</th>
                    <th className="px-3 py-2 font-medium">Already</th>
                    <th className="px-3 py-2 font-medium">This schedule</th>
                    <th className="px-3 py-2 font-medium">Total / cap</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.days.map((d) => (
                    <tr key={d.day} className="border-t border-line tabular-nums">
                      <td className="px-3 py-1.5">{d.day}</td>
                      <td className="px-3 py-1.5">{d.already}</td>
                      <td className="px-3 py-1.5">{d.planned}</td>
                      <td className={`px-3 py-1.5 ${d.over ? "font-semibold text-bad" : ""}`}>
                        {d.total} / {preview.dailyCap}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {preview.problems.length > 0 ? (
            <Note tone="bad">
              <ul className="list-disc pl-5">{preview.problems.map((p) => <li key={p}>{p}</li>)}</ul>
            </Note>
          ) : (
            <>
              <Note tone="info">
                {count} signups · about {preview.expectedVerified} verify · each gets User + Team + Membership + a pending
                verification token. No email is sent.
              </Note>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex flex-1 flex-col gap-1.5">
                  <label htmlFor="confirm" className="text-sm">
                    Type <Mono>{TARGET}</Mono> to schedule
                  </label>
                  <input id="confirm" autoComplete="off" spellCheck={false} className={`${inputCls} font-mono`} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                </div>
                <Button onClick={create} disabled={busy || confirm.trim().toLowerCase() !== TARGET}>
                  {busy ? "Scheduling…" : `Schedule ${count} signups`}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Section>
  )
}

// ---- Jobs -----------------------------------------------------------------------------

function JobsSection({ jobs, dbOk, onChanged }: { jobs: JobSummary[]; dbOk: boolean; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <Section title="3 · Schedules" hint="Live progress. Updates every few seconds.">
      {jobs.length === 0 ? (
        <Note tone="info">Nothing scheduled yet.</Note>
      ) : (
        <div className="flex flex-col gap-3">
          {jobs.map((j) => (
            <JobCard key={j.id} job={j} dbOk={dbOk} open={open === j.id} onToggle={() => setOpen(open === j.id ? null : j.id)} onChanged={onChanged} />
          ))}
        </div>
      )}
    </Section>
  )
}

function JobCard({ job, dbOk, open, onToggle, onChanged }: { job: JobSummary; dbOk: boolean; open: boolean; onToggle: () => void; onChanged: () => Promise<void> }) {
  const [err, setErr] = useState("")
  const [cleanup, setCleanup] = useState(false)
  const active = job.status === "scheduled" || job.status === "running"
  const t = Math.max(1, job.total)
  const seg = [
    { n: job.verified, cls: "bg-ok", label: "verified" },
    { n: job.signedUp, cls: "bg-accent", label: "signed up" },
    { n: job.skipped + job.failed, cls: "bg-bad", label: "skipped/failed" },
    { n: job.deleted, cls: "bg-muted", label: "deleted" },
  ]

  async function control(action: "pause" | "resume" | "cancel") {
    setErr("")
    try {
      await send(`/api/jobs/${job.id}`, "PATCH", { action })
      await onChanged()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <div className="rounded-lg border border-line">
      <div className="flex flex-col gap-3 p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium">{job.label}</span>
          <Chip status={job.status} />
          <span className="font-mono text-xs text-muted">{job.id}</span>
        </div>
        <div className="flex h-2 overflow-hidden rounded-full bg-code" title={seg.map((s) => `${s.n} ${s.label}`).join(" · ")}>
          {seg.map((s) => s.n > 0 && <div key={s.label} className={s.cls} style={{ width: `${(s.n / t) * 100}%` }} />)}
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted sm:grid-cols-4">
          <span>
            <b className="text-fg tabular-nums">{job.signedUp + job.verified}</b> / {job.total} signed up
          </span>
          <span>
            <b className="text-fg tabular-nums">{job.verified}</b> verified · {job.awaitingVerify} to go
          </span>
          <span>
            Window {fmtTime(job.windowStart)} → {fmtTime(job.windowEnd)}
          </span>
          <span>
            {active || job.status === "paused" ? `Next ${relative(job.nextEvent)}` : `${job.pending} pending`}
            {job.deferrals > 0 && ` · ${job.deferrals} deferred by cap`}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={onToggle}>
            {open ? "Hide users" : "Users & log"}
          </Button>
          {active && <Button variant="ghost" onClick={() => control("pause")}>Pause</Button>}
          {job.status === "paused" && <Button variant="ghost" onClick={() => control("resume")}>Resume</Button>}
          {(active || job.status === "paused") && <Button variant="ghost" onClick={() => control("cancel")}>Cancel</Button>}
          <a className={`${btnBase} ${btnVariants.ghost}`} href={`/api/records/export?job=${job.id}`}>
            Export
          </a>
          <Button variant="ghost" onClick={() => setCleanup((c) => !c)} disabled={!dbOk || job.signedUp + job.verified + job.pending === 0} className="sm:ml-auto">
            Delete from prod…
          </Button>
        </div>
        {err && <Note tone="bad">{err}</Note>}
      </div>
      {cleanup && <CleanupPanel jobId={job.id} onDone={onChanged} onClose={() => setCleanup(false)} />}
      {open && <JobUsers jobId={job.id} />}
    </div>
  )
}

function JobUsers({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<JobDetail | null>(null)
  const [reveal, setReveal] = useState(false)
  const [filter, setFilter] = useState("")
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = () => api<JobDetail>(`/api/jobs/${jobId}`).then((j) => alive && setJob(j)).catch(() => {})
    load()
    const t = setInterval(load, 5000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [jobId])

  if (!job) return <div className="border-t border-line p-4 text-sm text-muted">Loading…</div>
  const users = job.users.filter((u) => !filter || u.email.includes(filter.toLowerCase()) || u.state === filter)

  async function copy(key: string, v: string) {
    await navigator.clipboard.writeText(v)
    setCopied(key)
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200)
  }

  return (
    <div className="flex flex-col gap-3 border-t border-line bg-bg p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${inputCls} max-w-xs`} placeholder="Filter by email or stage" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Button variant="ghost" onClick={() => setReveal((r) => !r)}>
          {reveal ? "Hide passwords" : "Show passwords"}
        </Button>
        <span className="text-xs text-muted">{users.length} shown · click a password to copy</span>
      </div>
      <div className="max-h-96 overflow-auto rounded-lg border border-line bg-panel">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-code text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Password</th>
              <th className="px-3 py-2 font-medium">Stage</th>
              <th className="px-3 py-2 font-medium">Planned</th>
              <th className="px-3 py-2 font-medium">Signed up</th>
              <th className="px-3 py-2 font-medium">Verified</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.email} className="border-t border-line">
                <td className="px-3 py-1.5 font-mono text-[0.8125rem] break-all">{u.email}</td>
                <td className="px-3 py-1.5">
                  <button className="font-mono text-[0.8125rem] hover:text-accent" onClick={() => copy(u.email, u.password)} title="Copy password">
                    {copied === u.email ? "copied" : reveal ? u.password : "••••••••"}
                  </button>
                </td>
                <td className="px-3 py-1.5"><Chip status={u.state} /></td>
                <td className="px-3 py-1.5 whitespace-nowrap text-muted">{fmtFull(u.plannedAt)}</td>
                <td className="px-3 py-1.5 whitespace-nowrap">{fmtFull(u.signedUpAt)}</td>
                <td className="px-3 py-1.5 whitespace-nowrap">
                  {u.verifiedAt ? fmtFull(u.verifiedAt) : u.verifyAt ? <span className="text-muted">{relative(u.verifyAt)}</span> : u.willVerify ? "" : <span className="text-muted">never</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {job.log.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-muted">Log ({job.log.length})</summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-code p-3 font-mono text-xs whitespace-pre-wrap">
            {job.log.slice().reverse().map((l) => `${fmtFull(l.at)}  ${l.msg}`).join("\n")}
          </pre>
        </details>
      )}
    </div>
  )
}

function CleanupPanel({ jobId, onDone, onClose }: { jobId: string; onDone: () => Promise<void>; onClose: () => void }) {
  const [plan, setPlan] = useState<CleanupPlan | null>(null)
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null)

  useEffect(() => {
    send<CleanupPlan>(`/api/jobs/${jobId}/cleanup`, "POST", { action: "plan" })
      .then(setPlan)
      .catch((e) => setMsg({ tone: "bad", text: (e as Error).message }))
  }, [jobId])

  async function run() {
    if (!plan) return
    setBusy(true)
    try {
      const r = await send<{ deleted: number }>(`/api/jobs/${jobId}/cleanup`, "POST", { action: "run", expected: plan.deletable.length, confirm })
      setMsg({ tone: "ok", text: `Deleted ${r.deleted} users (with their teams, memberships and tokens). Their emails are back in the pool.` })
      setPlan(null)
      await onDone()
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 border-t border-line bg-bad-bg/40 p-3 sm:p-4">
      {!plan && !msg && <span className="text-sm text-muted">Checking prod…</span>}
      {plan && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Users to delete" value={plan.deletable.length} tone="bad" sub={`${plan.teams} teams · ${plan.tokens} tokens`} />
            <Stat label="Pending to cancel" value={plan.pendingToCancel} />
            <Stat label="Held back" value={plan.blocked.length + plan.mismatched.length} tone={plan.blocked.length + plan.mismatched.length ? "warn" : undefined} />
            <Stat label="Already gone" value={plan.alreadyGone.length} />
          </div>
          {plan.blocked.length > 0 && (
            <Note tone="warn">
              <strong>Held back — they own live resources.</strong> Destroy these in the admin first:
              <ul className="mt-1 list-disc pl-5">{plan.blocked.map((u) => <li key={u.userId}>{u.email}: {u.reasons.join(", ")}</li>)}</ul>
            </Note>
          )}
          {plan.mismatched.length > 0 && (
            <Note tone="warn">
              <strong>Held back — email changed on prod:</strong>
              <ul className="mt-1 list-disc pl-5">{plan.mismatched.map((u) => <li key={u.userId}>{u.recordedEmail} → {u.currentEmail}</li>)}</ul>
            </Note>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-1.5">
              <label className="text-sm" htmlFor={`c-${jobId}`}>
                Type <Mono>{TARGET}</Mono> to delete {plan.deletable.length} users and cancel {plan.pendingToCancel} pending
              </label>
              <input id={`c-${jobId}`} className={`${inputCls} font-mono`} autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
            <Button variant="danger" onClick={run} disabled={busy || confirm.trim().toLowerCase() !== TARGET}>
              {busy ? "Deleting…" : "Delete"}
            </Button>
            <Button variant="ghost" onClick={onClose}>Close</Button>
          </div>
        </>
      )}
      {msg && <Note tone={msg.tone}>{msg.text}</Note>}
    </div>
  )
}

// ---- Records -----------------------------------------------------------------------------

function RecordsSection({ status }: { status: Status | null }) {
  return (
    <Section
      title="4 · Records"
      hint="Every test user ever planned: email, password, stage, planned / signed-up / verified times, prod user and team ids."
    >
      <div className="flex flex-wrap items-center gap-2">
        <a className={`${btnBase} ${btnVariants.primary}`} href="/api/records/export?format=xlsx">
          Download all (Excel)
        </a>
        <a className={`${btnBase} ${btnVariants.ghost}`} href="/api/records/export?format=csv">
          CSV
        </a>
        <span className="text-sm text-muted">
          {status ? `${status.totals.jobs} schedules · ${status.totals.created} live test users` : ""}
        </span>
      </div>
      <p className="mt-3 text-xs text-muted">
        The file holds plain-text passwords. Times are UTC. Prod stores only the bcrypt hash.
      </p>
    </Section>
  )
}
