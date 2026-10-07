import type { Job } from "./store"

export function summarize(j: Job) {
  const count = (s: string) => j.users.filter((u) => u.state === s).length
  const pending = j.users.filter((u) => u.state === "pending")
  const awaitingVerify = j.users.filter((u) => u.state === "signed-up" && u.willVerify && u.verifyAt)
  const next = [...pending.map((u) => u.plannedAt), ...awaitingVerify.map((u) => u.verifyAt!)].sort()[0] ?? null
  return {
    id: j.id,
    label: j.label,
    createdAt: j.createdAt,
    status: j.status,
    windowStart: j.windowStart,
    windowEnd: j.windowEnd,
    verifyPct: j.verifyPct,
    verifyDelayMin: j.verifyDelayMin,
    freeAgentLimit: j.freeAgentLimit,
    database: j.database,
    total: j.users.length,
    pending: pending.length,
    signedUp: count("signed-up"),
    verified: count("verified"),
    skipped: count("skipped"),
    failed: count("failed"),
    cancelled: count("cancelled"),
    deleted: count("deleted"),
    awaitingVerify: awaitingVerify.length,
    deferrals: j.users.reduce((n, u) => n + u.deferrals, 0),
    nextEvent: next,
    lastLog: j.log.slice(-5),
  }
}
