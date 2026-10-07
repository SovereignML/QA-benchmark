import { NextResponse, connection } from "next/server"
import { dbStatus } from "@/lib/db"
import { guard } from "@/lib/http"
import { poolSummary } from "@/lib/pool"
import { schedulerStatus } from "@/lib/scheduler"
import { getSettings, listJobs } from "@/lib/store"
import { dayKey, TARGET_HOST, timeZone } from "@/lib/target"

export async function GET(req: Request) {
  await connection()
  const blocked = guard(req)
  if (blocked) return blocked
  const [db, settings, jobs, pool] = await Promise.all([dbStatus(), getSettings(), listJobs(), poolSummary()])
  const today = dayKey(Date.now())
  let createdToday = 0
  let plannedToday = 0
  let nextEvent: string | null = null
  for (const j of jobs) {
    const active = j.status === "scheduled" || j.status === "running"
    for (const u of j.users) {
      if (u.signedUpAt && dayKey(u.signedUpAt) === today) createdToday++
      if (active && u.state === "pending") {
        if (dayKey(u.plannedAt) === today) plannedToday++
        if (!nextEvent || u.plannedAt < nextEvent) nextEvent = u.plannedAt
      }
      if (active && u.state === "signed-up" && u.verifyAt && (!nextEvent || u.verifyAt < nextEvent)) nextEvent = u.verifyAt
    }
  }
  return NextResponse.json({
    target: TARGET_HOST,
    timeZone: timeZone(),
    today,
    now: new Date().toISOString(),
    db,
    scheduler: schedulerStatus(),
    settings,
    createdToday,
    plannedToday,
    nextEvent,
    pool,
    totals: {
      jobs: jobs.length,
      created: jobs.reduce((n, j) => n + j.users.filter((u) => u.signedUpAt && u.state !== "deleted").length, 0),
      verified: jobs.reduce((n, j) => n + j.users.filter((u) => u.state === "verified").length, 0),
    },
  })
}
